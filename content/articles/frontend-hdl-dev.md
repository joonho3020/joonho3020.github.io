+++
title = "Developing a Frontend HDL"
date = "2026-01-02"

[extra]
toc = true
+++

# Introduction

I love Chisel[^1], but I wanted to build my own HDL.
After all, what else can you do when you’re stuck in Iowa for the winter?

This post covers what I tried, what worked, and what didn’t while building a new HDL frontend.
I’ll focus on host-language tradeoffs, the features I changed relative to Chisel, and a few example designs I built with the HDL.

# Choosing the Abstraction

Many experimental HDLs add abstractions like pipelining, latency-insensitive circuits, or dataflow networks, but they usually fall short in practice.
They rarely scale to serious designs, so they end up limited to toy examples.
HLS tools exist too, but adoption is still limited because QoR is often unpredictable and worse than handwritten RTL.
Until HLS consistently matches or beats RTL QoR, it’s unlikely to see broad use in production.

What many hardware designers want instead is a strong metaprogramming layer on top of RTL.
That lets you express complex designs while still keeping QoR under control.
You see the same pattern in domains where output quality is critical.
So this HDL sticks to registers, wires, memories, and combinational logic.

# Choosing a Host Language

The most practical approach is an embedded DSL.
Building a new language from scratch is a lot of work: lexer, parser, type checker, language server, syntax highlighting, packaging, and a standard library.
By embedding the HDL in an existing host language, you get most of that for free.

So what language features matter most?

- Operator overloading and custom operators: without them, the syntax quickly gets clunky
- Flexible constructors and function overloading: also required for elegant syntax
- Static typing: enables compile-time checks and better LSP integration
- Type classes and derivation: encodes operations as types and generates boilerplate safely
- Macros: reduces boilerplate

The table below summarizes how each language suites each criterion:

| Language   | New/custom operators                   | Function overloading    | Static typing | Type classes      | Derivation              | Macros / Meta                            | Flexible constructor         |
| ---------  | -----------------------------------    | ----------------------- | -----------   | ----------------- | ----------------------  | -------------------------------------    | ---------------------------- |
| Haskell    | ✓ (custom + fixity)                    | ~ (via type classes)    | ✓             | ✓                 | ✓                       | ✓ (Template Haskell)                     | ✓                            |
| Scala 3    | ~ (symbolic names; coarse precedence)  | ✓                       | ✓             | ✓ (given/using)   | ~ (`derives`)           | ✓ (quotes/splices, inline)               | ✓ (multiple parameter lists) |
| Swift 5.9+ | ✓ (custom + precedence)                | ✓                       | ✓             | ✓ (protocols)     | ✓ (built-ins + macros)  | ✓ (declarative macros, result builders)  | x                            |
| OCaml/F#   | ~ (limited)                            | ~                       | ✓             | ~                 | ~                       | ~ (ppx/quotations)                       | ✓                            |
| Python     | ✗ (no new ops; only overload existing) | ~ (single-dispatch)     | x[^3]         | ~ (protocols)     | ~ (dataclasses)         | ✓ (decorators, metaclasses)              | ✓ (kwargs, defaults)         |
| Zig        | ✗                                      | ✗                       | ✓             | ✗                 | ~ (via `comptime`)      | ✓ (`comptime`, generics)                 | x                            |
| Rust       | ✗                                      | ✗                       | ✓             | ✓ (traits)        | ✓ (derive)              | ✓                                        | x                            |
| Mojo       | ~ (cannot define generic custom ops)   | ✗                       | ✓             | ✓ (traits)        | x (derive)              | ✓                                        | x                            |
| Nim 2.x    | ✓ (user operators)                     | ✓                       | ✓             | ~ (concepts)      | ✓ (macros)              | ✓ (hygienic macros, CTFE)                | x                            |
| D          | ✗ (no new ops; only overload existing) | ✓                       | ✓             | ~ (templates)     | ~ (templates/mixins)    | ✓ (CTFE, mixins)                         | x                            |
| Crystal    | ~ (cannot define generic custom ops)   | ✓                       | ✓             | ~(modules)        | ~ (annos, codegen)      | ✓                                        | ~                            |

## Nim

Nim is an interesting choice as it has flexible operator and function overloading, a strong macro system, and static types.
But you also see what happens to HDL ergonomics when there’s no apply[^2]-style constructor.

In the example below, because there’s no `apply`, I define the type as `XObj` and the constructor as `X`.
The `Obj` suffix then leaks into bundle composition (for example, `bar` in `NestedBundle`).
This gets nasty quickly once you have multiple levels of nested bundles.

```nim
type WidthObj* = ref object
    width: int

proc Width*(width: int): WidthObj = WidthObj(width: width)

type
  UIntObj* = ref object
    width*: WidthObj

proc UInt*(width: WidthObj): UIntObj = UIntObj(width: width)


type Bundle = ref object of RootObj

type MyBundle = ref object of Bundle
  a: UIntObj
  b: UIntObj

type NestedBundle = ref object of Bundle
  foo: MyBundle
  bar: UIntObj
```

Full code here: [nim-hdl](https://github.com/joonho3020/nim-tutorial/blob/main/hdl.nim)

## Swift

Swift often pushes you toward explicit initializers, which makes bundle/struct definitions more verbose (Scala can run into the same issue if you want derivation and end up using case class + companion).

For example, if you want `target` and `taken` to be parameterized, you have to write a `init`:

```swift
class BPred: Bundle {
    let target: HWUInt
    let taken:  HWUInt

    public init(_ x: Int, _ y: Int) {
        self.target = HWUInt(x.W)
        self.taken  = HWUInt(y.W)
    }
}
```

Full code here: [swift-hdl](https://github.com/joonho3020/swift-hdl)

On the bright side, the macro system is well-designed (and much easier to work with than Scala macros).
Operators are flexible, function overloading is solid, and `init` is a close equivalent to `apply`.
I still chose Scala 3, partly out of bias, but also because some of its newer features make it much easier to build a good literals API.
More on that in the Bundles section. <!-- It would be nice if we can reference other parts of the article and jump back and forth -->

## Scala 3

From the table above, Scala 3 looks like the best fit.
I’ll stick with Scala 3 for the rest of this post.

# Language Implementation

## Bundles

### Goals

Let’s start with the goals.

```scala
case class MyBundle(val a: UInt, val b: UInt) extends Bundle
```

Given the bundle above, I want to derive constructors for Literals and DPI.
If you’re familiar with Rust, this is the rough equivalent of `#[derive(Literals, DPI)]`.
So why do we want this feature?
Let’s look at how Chisel implements `Bundle`s and what that implies.

In Chisel, `Bundle`s are implemented as `Record` types.
`Record`s are basically `Dict[String, Data]`, where the key is the name of each field.

```scala
class MyBundle extends Bundle {
  val a = UInt(8.W)
  val b = Bool()
}
```

Conceptually, the compiler turns `MyBundle` into something like:

```
{ "a" -> UInt, "b" -> Bool }
```

The consequence is that you end up with a fairly awkward API for bundle literals and peek/poke-style testing.

Here’s how literals work for `Bundle`s in Chisel:

```scala
dut.in.poke((new MyBundle).Lit(_.a -> 3.U, _.b -> true.B))
```

Because the bundle behaves like a dictionary, you assign values to keys.
Now suppose you add a new field, `val c = SInt(2.W)`, to `MyBundle`.
The code still compiles, and `c` can silently become `DontCare`.

Now imagine an alternative where the literals API is derived from the bundle schema:

```scala
// today
out := (new MyBundle).Lit(_.a -> 3.U, _.b -> true.B)

// with derivation
out := MyBundle.lit(a = 3.U, b = true.B)
```

This is nicer for several reasons:
- The API is cleaner (named parameters)
- LSP autocompletion can suggest field names
- If you require all fields to be assigned, adding a new field can produce a compile error at call sites, which is what you want for maintainability

In the following sections, I’ll walk through the attempts to achieve this API as well as the takeaways.

### Trial 1: Using Structural Types

In the first iteration, I tried Scala 3 macros and compiler plugins to see if we could derive literal definitions from structural types.
The motivation was to avoid using `case class` for `Bundle`s, since it forces you to duplicate the schema and its constructors:

```scala
case class MyBundle(val a: UInt, val b: UInt) extends Bundle

// Designers now have to define constructors for each bundle schema
object MyBundle {
  def apply(wa: Int): MyBundle = {
    new MyBundle(UInt(wa.W), UInt((wa+2).W)))
  }
}
```

To proceed, I defined `Bundle` using structural types and `Selectable`.
If you aren’t familiar with structural types in Scala 3, you can think of them as “objects whose fields are computed dynamically,”.

A minimal Bundle skeleton looks like this:

```scala
class Bundle(elems: (String, Any)*) extends Selectable with Signal:
  private val fields = elems.toMap
  def selectDynamic(name: String): Any = fields(name)
```

Now you can define parameterized bundles as well as nested bundles like this:

```scala
class MyBundle(x: Int, y: Int) extends Bundle:
  val a = UInt(Width(x))
  val b = UInt(Width(y))

class NestedBundle(x: Int, y: Int, z: Int) extends Bundle:
  val width_outer = x + y + z
  val inner = new MyBundle(x, y)
  val outer = UInt(Width(width_outer))
```

So far so good.
Now going back to our goal which is to be able to use a `Bundle` as an interface between hardware blocks (i.e., RTL ports), DPI interfaces (RTL vs SW), and to define literals.
And we want the APIs to these methods to be statically typed with named arguments.
Since recursive typeclass derivation doesn't work so well for structural types, we can resort to macros.
The `.lit` will be generated for subclasses of each bundle where the API will look like this: `MyBundle.lit(a = 3.U, b = true.B)`.

First, I defined an entry point that expands to a macro:

```scala
object Bundle:
  transparent inline def lit[B <: Bundle](inline elems: (String, Signal)*): Any =
    ${ BundleMacros.bundleLitImpl[B]('elems) }
```

I won't go into the macro implementation.
The high-level idea is: given a mapping from field names to their literal types, generate a `Bundle` with the corresponding fields and types.

Then, to generate `.lit` for `MyBundle`, the user defines a forwarding method in `MyBundle`’s companion object.
`Bundle.lit` gets expanded into the macro implementation.
That gives a typed API for the lit method:

```scala
object MyBundle:
  transparent inline def lit(inline a: UIntLit, inline b: UIntLit): Any =
    Bundle.lit[MyBundle]("a" -> a, "b" -> b)
```

However, it’s ugly that we have to repeat the fields `a` and `b` three more times to make this work for `MyBundle`.
For nested bundles, this becomes unbearable.

So the next idea was to generate that `lit` function automatically in companion objects too.
Scala 3 macros can’t generate arbitrary companion-object members, so this is where compiler plugins come in.
A plugin can insert a custom compiler pass, analyze the AST, and rewrite it to inject methods.

The compiler pass to inject a trivial `.lit()` method (scaffolding only—no arguments yet) looked roughly like this:

```scala
final class InjectPhase extends PluginPhase {
  override val phaseName  = "bundleinject"
  override val runsAfter  = Set("typer")
  override val runsBefore = Set("bundleexamine")

  override def transformPackageDef(tree: PackageDef)(using Context): Tree = {
    println(s"[bundle-lit] visiting ${tree.pid.show}")

    // Resolve hdl.Bundle
    val bundleClass: ClassSymbol = requiredClass("hdl.Bundle")

    // Collect classes in this package that are subclasses of Bundle
    val bundleOwners = scala.collection.mutable.HashSet[ClassSymbol]()
    tree.foreachSubTree {
      case td: TypeDef if td.isClassDef =>
        val cls = td.symbol.asClass
        val isSubclass = cls.isSubClass(bundleClass)
        if isSubclass && cls != bundleClass then
          bundleOwners += cls
      case _ =>
    }

    // Rewrite companion modules for those classes: inject trivial lit() if missing
    val newStats = tree.stats.map {
      case td: TypeDef if td.isClassDef && td.symbol.is(ModuleClass) =>
      // ... MANY LINES OF MAGICAL SCALA
    }

    cpy.PackageDef(tree)(tree.pid, newStats)
  }
})
```

At this point you might think `MyBundle.lit()` should compile.
Unfortunately, the answer is that it doesn't.
Because this pass runs **after typer**, any call site that references `MyBundle.lit` fails during typing: the method doesn’t exist yet, so name resolution fails before the plugin gets a chance to inject it.
If I move the pass **before typer**, I can inject the method early enough for name resolution—but now I don’t have reliable type information to generate a type-safe signature, and I’m forced to use heuristics.

In theory, you could split bundles into a separate compilation unit/package, run the injection on that, then depend on it from the RTL package.
In practice, parameterized bundles make that approach painful quickly.
After wrestling with Scala 3 macros and compiler plugins, I took a different path.

### Trial 2: NamedTuples

While digging through Scala 3 blog posts and talks, I came across this article: [whiteboxish-named-tuples](https://blog.daniel-beskin.com/2025-04-14-whiteboxish-named-tuples).

>```scala
>object Foo extends Selectable: // 1
>  type Fields = (hello: String, meaningOfLife: Int) // 2
>
>  def selectDynamic(field: String): Any = // 3
>    field match // 4
>      case "hello" => "world"
>      case "meaningOfLife" => 42
>      case _ => sys.error("cannot happen unless `selectDynamic` is called directly") // 5
>```
>Here we are defining a new Selectable object (1) to enable "dynamically" computed fields.
>In (2) we define the type member Fields which is a named tuple that specifies the members that the compiler will allow us to select on Foo.
>These are the "computed field names".
>The named tuple that we use here can come from an arbitrary (type-level) computation.
>Something that'll we'll take advantage of later on.
>
>Next we implement field access with `selectDynamic` (3), which receives the name of the field being accessed as a string, and returns Any.
>Although nothing is enforcing the correctness of the `selectDynamic` implementation, type safety is somewhat retained by the fact that the user is only allowed to call the fields that are specified in the Fields named tuple (almost, see below).
>
>With the field name in hand, we match on it (4), and produce the appropriately typed result (as specified by Fields).
>Though we return Any here, the compiler will cast the value to the correct type at runtime.
>We must be careful to obey the contract, otherwise we'll get a runtime cast exception.

The structure of this resembles the relationship between bundles and literals very closely!
It uses a `Selectable` whose legal field names are described by a `NamedTuple` type member.
Field access is “dynamic” at runtime, but the compiler still restricts which fields you’re allowed to select.

The idea for literals is that `Fields` should be a `NamedTuple` where the field names come from the `Bundle` definition.
The types are the corresponding host-language datatypes for each hardware type (e.g., `BigInt` for `UInt`, and `Boolean` for `Bool`).

First, we define a type-level mapping from hardware types (`UInt`, `Bool`, `Vec`, nested bundles, …) to host types (`Int`, `Boolean`, `Seq[...]`, nested tuples, …):

```scala
type HostTypeOf[T] = T match
  case UInt    => Int
  case Bool    => Boolean
  case Vec[t]  => Seq[HostTypeOf[t & ValueType]]
  case _       => NamedTuple.Map[NamedTuple.From[T], [X] =>> HostTypeOf[X & ValueType]]
```

Now define a `Lit[T]` wrapper[^4]. `T` is the hardware type, and payload is a product with the same shape as `T`.

```scala
final class Lit[T](private val payload: Any) extends Selectable:
  type Fields = NamedTuple.Map[  // 1
    NamedTuple.From[T],
    [X] =>> Lit[X & ValueType]
  ]

  inline def selectDynamic(name: String): Lit[?] =
    summonFrom {
      case m: Mirror.ProductOf[T] => // 2
        val labels = constValueTuple[m.MirroredElemLabels].toArray
        val idx = labels.indexOf(name)
        val subpayload = payload.asInstanceOf[Product].productElement(idx) // 3
        new Lit[Any](subpayload) // 4
      case _ =>
        throw new NoSuchElementException(s"${summonInline[ValueOf[String]]}")
    }
  transparent inline def get: HostTypeOf[T] =
    payload.asInstanceOf[HostTypeOf[T]]
```

In (1) we define the computed field names for the `Lit` class.
Specifically, we can iterate over the fields of type `T` using `NamedTuple.Map`, and transform the return type to be a `Lit[X]` for each subfield type `X`.
Next, we desugar the type `T` as a product type in (2), find the subfield payload used in (3), and return the subfield literal for field `name` in (4).

This gives us the following:

```scala
@main def demo(): Unit =
  final case class InnerVecBundle(a: UInt, b: Vec[UInt]) extends Bundle
  final case class MyVecBundle(i: Vec[InnerVecBundle], c: Bool) extends Bundle
  val mvb = MyVecBundle(
    Vec(
      InnerVecBundle(
        UInt(Width(2)),
        Vec(UInt(Width(3)), 2)
      ),
      3
    ),
    Bool()
  )

  val mvb_lit = Lit[MyVecBundle]((
    i = Seq.fill(3)((a = 3, b = Seq(1, 2))), // 1
    c = true
  ))
  val mvb_lit_i0_a: Lit[UInt] = mvb_lit.i(0).a // 2
  println(s"mvb_lit_i0_a ${mvb_lit_i0_a.get}")

  val mvb_lit_i1_b: Lit[Vec[UInt]] = mvb_lit.i(1).b // 3
  println(s"mvb_lit_i1_b ${mvb_lit_i1_b.get}")

  val mvb_lit_i1_b0: Lit[UInt] = mvb_lit.i(1).b(0) // 4
  println(s"mvb_lit_i1_b0 ${mvb_lit_i1_b0.get}")
```

The payload construction is pleasant (1), and subfield access is typed with strong LSP support (2, 3, 4).

The tradeoff is that bundle definitions now need to be `case class` product types.
That’s slightly more verbose than Chisel, but the derived APIs and tooling benefits are large enough that it may be worth it.

## Directionality

I initially tried to encode directionality in types and reject illegal connections at compile time.
It sounds cool, but there are too many corner cases.

For leaf assignments, the legality depends on whether the destination/source is readable & writable (register/wire), read-only (input), or write-only (output).
For bulk connections, you need those constraints to hold recursively across all fields.
Encoding that into Scala’s type system quickly makes signatures heavy and ruins ergonomics.
I ended up resolving directionality at runtime.

That said, we can still improve over Chisel practically.
Since bundles are `case class` product types, we can use typeclass derivation to enforce that the LHS and RHS have the same shape, while also supporting the special case where the RHS is `DontCare`.

Finally, I provide a fallback `::=` for cases where users intentionally want a weaker type discipline (for example, union types like `UInt | DontCare.type` can be useful for metaprogramming).

In practice, this catches a lot of accidental illegal connections as compile errors.

```scala
/** Typeclass for connecting leaf hardware values with :=. */
trait LeafConnect[D <: HWData, S <: HWData]:
  /** Connect dst from src. */
  def :=(dst: D, src: S)(using Module): Unit

object LeafConnect:
  given sameHWData[T <: HWData]: LeafConnect[T, T] with
    def :=(dst: T, src: T)(using m: Module) =
      ModuleOps.connect(dst, src, m)

  given dontCare[T <: HWData]: LeafConnect[T, DontCare.type] with
    def :=(dst: T, src: DontCare.type)(using m: Module) =
      ModuleOps.connect(dst, src, m)

/** Typeclass for connecting aggregate hardware values with <>. */
trait AggregateConnect[D <: AggregateHWData, S <: HWData]:
  /** Bulk-connect dst from src. */
  def <>(dst: D, src: S)(using Module): Unit

object AggregateConnect:
  given sameHWData[T <: AggregateHWData]: AggregateConnect[T, T] with
    def <>(dst: T, src: T)(using m: Module) =
      ModuleOps.connect(dst, src, m)

  given dontCare[T <: AggregateHWData]: AggregateConnect[T, DontCare.type] with
    def <>(dst: T, src: DontCare.type)(using m: Module) =
      ModuleOps.connect(dst, src, m)

extension [D <: HWData](dst: D)
  /** Connect a leaf value from src using :=. */
  def :=[S <: HWData](src: S)(using lc: LeafConnect[D, S], m: Module): Unit =
    lc.:=(dst, src)

extension [D <: AggregateHWData](dst: D)
  /** Bulk-connect an aggregate from src using <>. */
  def <>[S <: HWData](src: S)(using lc: AggregateConnect[D, S], m: Module): Unit =
    lc.<>(dst, src)

// Fallback method to when typeclass derivation doesn't work
// Example of this case is union types such as: `UInt | DontCare.type`
// Users may want to use union types for metaprogramming, but enforcing too
// strong of a type requirement may hamper this ability.
extension [T <: HWData](dst: T)
  /** Fallback connect for cases where typeclass derivation is not used. */
  def ::=(src: T)(using m: Module): Unit =
    ModuleOps.connect(dst, src, m)
```

## Node Types

What should the type of `Reg(UInt())` be?
Should it be `Reg[UInt]`, `Node[UInt]` or just `UInt`?
I explored all three approaches and explain the tradeoffs that I've encountered for each one.

### Separating HW Value Types from HW Structure Types

One design point is to split value types (`UInt`, `SInt`, `Bool`) from structure types (`Reg`, `Wire`, `SRAM`, `IO`).
This is appealing because the types document intent, integrate nicely with the LSP, and line up with the literal types discussed above (i.e., `Lit`, `Reg`, and `Wire` are all wrappers around value types like `UInt`, `SInt`, and `Bundle`s).

For example, `Reg` can be implemented like this:

```scala
final class Reg[T](val t: T, val name: String = "") extends Selectable with TypedConnectable[T]:
  type Fields = NamedTuple.Map[
    NamedTuple.From[T],
    [X] =>> Reg[X & ValueType]]

  def innerType: T = t
  def refName: String = name

  inline def selectDynamic(fieldName: String): Reg[?] =
    summonFrom {
      case m: Mirror.ProductOf[T] =>
        val labels = constValueTuple[m.MirroredElemLabels].toArray
        val idx = labels.indexOf(fieldName)
        val child = t.asInstanceOf[Product].productElement(idx).asInstanceOf[ValueType]
        val childName = if name.isEmpty then fieldName else s"${name}.$fieldName"
        new Reg(child, childName)
      case _ =>
        throw new NoSuchElementException(s"${t.getClass.getName} has no field '$fieldName'")
    }
  override def toString(): String =
    s"Reg($t, $name)"
```

Usage:

```scala
final case class InnerBundle(a: UInt, b: UInt) extends Bundle
final case class MyBundle(x: UInt, y: UInt, i: InnerBundle) extends Bundle
val mb = MyBundle(UInt(Width(2)), UInt(Width(3)), InnerBundle(UInt(Width(4)), UInt(Width(5))))

val reg = Reg(mb)
val reg_x: Reg[UInt] = reg.x
val reg_y: Reg[UInt] = reg.y
val reg_i: Reg[InnerBundle] = reg.i
val reg_i_a: Reg[UInt] = reg_i.a
val reg_i_b: Reg[UInt] = reg.i.b
```

The downside is that common Scala collection operations become harder to use.
Below is an example where using Scala `Seq`'s `reduce` operation results in a type error.
`c.io.out` has type `IO[UInt]`, the result of `+` has type `Node[UInt]` (wrapper type for operation outputs), and `reduce` expects a function of type `(B, B) => B`, where the input and output types match.

```scala
class Fanout(level: Int, fanout: Int) extends Module:
  val io = IO(LinkIO(
    in = Input(UInt(Width(4))),
    out = Output(UInt(Width(4)))
  ))

  body:
    val children = (0 until fanout).map(i => Module(new Leaf(level * 10 + i)))
    io.out := children.map(c => c.io.out).reduce(_ + _)
```

Since metaprogramming with host-language data structures (especially lists) is a key reason to use an embedded DSL, any HDL feature that gets in the way is a problem.

*Takeaway: separate wrapper types (`Reg`, `Wire`, `IO`) make ordinary Scala list/collection operations painful because common operators stop preserving a single stable type.*

### Folding All Possible Structure Types into One

What if we represent all hardware structures with a single class `Node[T]`, distinguished by a `NodeKind` tag?

```scala
final case class Node[T](
  tpe: T,
  kind: NodeKind,
  name: Option[String] = None,
  literal: Option[Any] = None
) extends Selectable:
  type Fields = NamedTuple.Map[NamedTuple.From[T], [X] =>> X]

  transparent inline def selectDynamic[L <: String & Singleton](inline label: L) =
    summonFrom {
      case m: Mirror.ProductOf[T] =>
        type Labels = m.MirroredElemLabels
        type Elems = m.MirroredElemTypes
        type FT = FieldTypeFromTuple[Labels, Elems, L]
        val labels = constValueTuple[Labels].toArray
        val idx = labels.indexOf(constValue[L])
        if idx < 0 then throw new NoSuchElementException(s"${tpe.getClass.getName} has no field '${label}'")
        val childT = tpe.asInstanceOf[Product].productElement(idx).asInstanceOf[FT]
        val childLit = literal.map(_.asInstanceOf[Product].productElement(idx))
        Node(childT, kind, None, childLit)
      case _ =>
        throw new NoSuchElementException(s"${tpe.getClass.getName} has no field '${label}'")
    }
```

This creates a new problem: subfield access now returns a wrapped type, which breaks composition with ordinary Scala types like `Option`.
In the example below, `io.a` would have type `Node[Option[UInt]]`, which means you can’t call `map` on `io.a` anymore.

```scala
def optional_io_check(): Unit =
  class A(debug: Boolean, w: Int) extends Module:
    given Module = this
    case class MyBundle(
      a: Option[UInt],
      b: UInt,
      c: UInt
    ) extends Bundle

    val io = IO(MyBundle(
      a = if (debug) Some(Input(UInt(Width(w)))) else None,
      b = Input(UInt(Width(w))),
      c = Output(UInt(Width(w + 1)))
    ))
    io.c := io.b
    io.a.map { x =>
      io.c := x + io.b
    }
```

*Takeaway: subfield access should return the subfield type unmodified. This is exactly what Chisel does, and there’s a good reason for it. I ended up taking the same route.*

## Build Cache & Lazy Evaluation

One big downside of Chisel is elaboration latency.
A major contributor is the global, stateful `Builder` that gets mutated as each module elaborates.
That serializes the process and makes it hard to exploit parallelism.

To remove that bottleneck, I used two tricks:

### 1. Parallel elaboration

Module instances elaborate in parallel using an execution pool.
Independent instances can be scheduled concurrently.

```scala
  private def startElaboration(
    mod: Module, key: ModuleKey, label: String, isTop: Boolean
  ): Future[(Seq[ElaboratedDesign], Boolean)] =
    inProgress.getOrElseUpdate(key.value,
      // Submit `mod.runBody` to the execution pool
      Future(mod.runBody()).flatMap { _ =>
        val childFutures = mod.children.map(elaborateModule(_))

        // Submit all child `elaborateModule` to the execution pool
        Future.sequence(childFutures).map { childResults =>
          val childDesigns = childResults.flatMap(_._1)
          val anyChildFresh = childResults.exists(_._2)
          val canUseCache = key.cacheable && !isTop && !anyChildFresh

          val cachedDesign: Option[ElaboratedDesign] =
            if canUseCache then
              buildCache.get(key.value) match
                case Some(hit) =>
                  log(s"Cache Hit ${mod.getClass.getName} ${key} ${label}")
                  Some(hit.design)
                case None =>
                  log(s"Cache Miss ${mod.getClass.getName} ${key} ${label}")
                  None
            else if isTop then
              log(s"TopModule (not cached) ${mod.getClass.getName} ${key} ${label}")
              None
            else if anyChildFresh then
              log(s"Child Invalidated ${mod.getClass.getName} ${key} ${label}")
              None
            else
              log(s"NonCacheable ${mod.getClass.getName} ${key} ${label}")
              None

          val design = cachedDesign.getOrElse {
            val instLabelMap = labels.synchronized { labels.toMap }
            mod.getBuilder.snapshot(label, instLabelMap)
          }

          val isFresh = cachedDesign.isEmpty
          val result = (childDesigns :+ design).distinctBy(_.name)
          memoized.putIfAbsent(key.value, result)
          if key.cacheable && !isTop && isFresh then buildCache.put(key.value, CachedArtifact(design))
          (result, isFresh)
        }
      }
    )
```

### 2. Lazy evaluation + caching

We store module bodies as thunks, so you can skip elaboration entirely on cache hits.
If you eagerly execute the module body while computing a cache key, you’ve already lost the point of caching.

For cache keys, I hash the classfiles, their dependencies, and module instantiation parameters.
Dependencies can be approximated by parsing the classfile constant pool (which includes class references used for JVM linking).

The core API for lazy evaluation looks like this:

```scala
/** Registers the module body for lazy elaboration.
* Storing the module body as a thunk is required in order to achieve lazy elaboration.
* If the module body is elaborated eagerly, there is no point in incremental elaboration and caching. */
protected final def body(f: Module ?=> Unit): Unit =
  _bodyFn = Some(f)

private[hdl] def runBody(): Unit =
  if !_bodyRan then
    given Module = this
    _bodyFn.foreach(fn => fn(using summon[Module]))
    _bodyRan = true
```

which can be used like this:

```scala
class Queue[T <: HWData](x: T, entries: Int) extends Module with CacheableModule: // 1

  type ElabParams = (HWData, Int)  // 2
  given stableHashElabParams: StableHash[ElabParams] = StableHash.derived // 3
  def elabParams: ElabParams = (x, entries) // 4

  val io = IO(QueueBundle(x))

  body: // 5
    val addrBits = log2Ceil(entries + 1)
    val mem = Reg(Vec.fill(entries)(x))

    val enq_ptr = RegInit(0.U(Width(addrBits)))
    val deq_ptr = RegInit(0.U(Width(addrBits)))
    val full    = RegInit(false.B)
    val empty   = (enq_ptr === deq_ptr) && !full

    io.enq.ready := !full
    io.deq.valid := !empty
    io.deq.bits  := mem(deq_ptr)

    val enq_fire = io.enq.valid && io.enq.ready
    val deq_fire = io.deq.valid && io.deq.ready
    val almost_full = (enq_ptr + 1.U) % entries.U === deq_ptr

    when (enq_fire) {
      enq_ptr := (enq_ptr + 1.U) % entries.U
      mem(enq_ptr) := io.enq.bits
    }

    when (deq_fire) {
      deq_ptr := (deq_ptr + 1.U) % entries.U
    }

    when (enq_fire && deq_fire) {
    } .elsewhen (enq_fire && almost_full) {
      full := true.B
    } .elsewhen (deq_fire) {
      full := false.B
    }
```

(1), (2), (3), (4) provides the elaborator information about the parameters that should be used to generate a hash key for this module.
(5) is how the `body` API can be used to guard against eager execution.

One thing to note that the caching scheme assumes that the module body is a referentially transparent function.
It should not contain code that updates external variables.
For these modules, users should opt-out from this caching scheme by not mixing in the `CacheableModule` trait.

## Enums

In Chisel, enums typically become `UInt` literals.
I wanted to derive hardware enum types directly from Scala enums.
This is possible using compile-time reflection:

```scala
/** Hardware enum value backed by a Scala enum. */
class HWEnum[E <: scala.reflect.Enum](
  val enumObj: { def values: Array[E] }
) extends HWData with Bits:
  def setLitVal(payload: Any): Unit = literal = Some(payload.asInstanceOf[E])
  def getLitVal: E =
    literal match
      case Some(v) => v.asInstanceOf[E]
      case None => throw new NoSuchElementException("Enum does not carry a literal value")
  override def cloneType: this.type = new HWEnum[E](enumObj).asInstanceOf[this.type]
  this.width = Width(log2Ceil(math.max(1, enumObj.values.length)))
```

This enables designers to define `HWEnum` types using Scala3 enums like this:

```scala
// Scala Enum
enum Immediates:
  case
    IMM_S,
    IMM_SB,
    IMM_U,
    IMM_UJ,
    IMM_I,
    IMM_Z

case class ImmGenIO(
  inst: UInt,
  sel: HWEnum[Immediates], // We can use Scala enums to create HW enums!
  out: UInt
) extends Bundle[ImmGenIO]

class ImmGen(xlen: Int) extends Module:
  val io = IO(ImmGenIO(
      inst = Input(UInt(xlen.W)),
      sel = Input(HWEnum(Immediates)),
      out = Output(UInt(xlen.W))
    ))

  body:
    val immI  = Wire(UInt(xlen.W))
    immI := Cat(Seq(Fill(xlen - 10, io.inst(31)), io.inst(31, 20)))

    // Some more code ...

    import Immediates._
    switch (io.sel) {
      is(IMM_I .EN) { io.out := immI     } // .EN converts the IMM_I Scala enum into a HWEnum type
      // Some other cases ...
      default       { io.out := DontCare }
    }
```


## Switch Statments

We can define switch statements using typeclass derivation:

```scala
trait SwitchCond[S, C]:
  def apply(lhs: S, rhs: C)(using Module): Bool

object SwitchCond:
  given SwitchCond[UInt, UInt] with
    def apply(lhs: UInt, rhs: UInt)(using Module): Bool =
      ModuleOps.prim2Op(Bool(), IR.PrimOp.Eq, lhs, rhs, summon[Module])

  given SwitchCond[Bool, Bool] with
    def apply(lhs: Bool, rhs: Bool)(using Module): Bool =
      ModuleOps.prim2Op(Bool(), IR.PrimOp.Eq, lhs, rhs, summon[Module])

  given [E <: scala.reflect.Enum]: SwitchCond[HWEnum[E], HWEnum[E]] with
    def apply(lhs: HWEnum[E], rhs: HWEnum[E])(using Module): Bool =
      if lhs.enumObj != rhs.enumObj then
        throw new IllegalArgumentException("Enum type mismatch")
      ModuleOps.prim2Op(Bool(), IR.PrimOp.Eq, lhs, rhs, summon[Module])

  given SwitchCond[EmptyTuple, EmptyTuple] with
    def apply(lhs: EmptyTuple, rhs: EmptyTuple)(using Module): Bool =
      true.B

  given [H, T <: Tuple](using h: SwitchCond[H, H], t: SwitchCond[T, T]): SwitchCond[H *: T, H *: T] with
    def apply(lhs: H *: T, rhs: H *: T)(using Module): Bool =
      h(lhs.head, rhs.head) && t(lhs.tail, rhs.tail)
```

This lets us extend switch statements naturally to tuples like this:

```scala
switch ((funct3, funct7)) {
  is ((0.U,    0.U)) { op :=  FN_ADD.EN }
  is ((0.U, 0x20.U)) { op :=  FN_SUB.EN }
  is ((1.U,    0.U)) { op :=   FN_SL.EN }
  is ((2.U,    0.U)) { op :=  FN_SLT.EN }
  is ((3.U,    0.U)) { op := FN_SLTU.EN }
  is ((4.U,    0.U)) { op :=  FN_XOR.EN }
  is ((5.U,    0.U)) { op :=   FN_SR.EN }
  is ((5.U, 0x20.U)) { op :=  FN_SRA.EN }
  is ((6.U,    0.U)) { op :=   FN_OR.EN }
  is ((7.U,    0.U)) { op :=  FN_AND.EN }
  default { op := DontCare }
}
```

## SRAM API

In Chisel, SRAMs are modeled as `SyncReadMemory`, which is a behavioral SRAM model.
That’s convenient, but it can also be surprising because the number of read/write/read-write ports is inferred.
In some cases, a read port and a write port can be merged into a read-write port if the compiler can prove their enables are mutually exclusive.

The catch is that this analysis is pessimistic: there are plenty of cases where mutual exclusivity can’t be proved statically, even though it holds dynamically.
For the frontend, designers would rather avoid “magic” port inference and make SRAM ports explicit.

One extreme is a fully structural SRAM interface:

```scala
// Declare a 2 read, 2 write, 2 read-write ported SRAM with 8-bit UInt data members
val mem = SRAM(1024, UInt(8.W), 2, 2, 2)

// Whenever we want to read from the first read port
mem.readPorts(0).address := 100.U
mem.readPorts(0).enable := true.B

// Read data is returned one cycle after enable is driven
val foo = WireInit(UInt(8.W), mem.readPorts(0).data)

// Whenever we want to write to the second write port
mem.writePorts(1).address := 5.U
mem.writePorts(1).enable := true.B
mem.writePorts(1).data := 12.U

// Whenever we want to read or write to the third read-write port
// Write:
mem.readwritePorts(2).address := 5.U
mem.readwritePorts(2).enable := true.B
mem.readwritePorts(2).isWrite := true.B
mem.readwritePorts(2).writeData := 100.U

// Read:
mem.readwritePorts(2).address := 5.U
mem.readwritePorts(2).enable := true.B
mem.readwritePorts(2).isWrite := false.B
val bar = WireInit(UInt(8.W), mem.readwritePorts(2).readData)
```

This makes everything explicit, but the wiring is tedious.

I think we can do better than both approaches by making ports explicit, but giving them a nicer API.
The key idea is that `read`/`write` are methods on a port handle: calling them drives `enable`, `address`, and data signals for you, while still keeping the port topology fully structural.

```scala
class SRAM[T <: HWData](x: T, entries: Int)(num_read_ports: Int, num_write_ports: Int, num_readwrite_ports: Int)

val sram = SRAM(UInt(3.W), 4)(4, 5, 6)

when (???)
    sram.readport(0).read(addr)
otherwise
    sram.readport(0).read(addr)

sram.readport(0).read(addr)

sram.readport(1).read(addr)

sram.write(2).write(addr, data)

when (read)
    sram.readwrite(3).read(addr)
otherwise
    sram.readwrite(3).write(addr)


val port_id = Reg(UInt(...))
... some logic to update port_id

sram.readwrite(port_id).read(addr)
```

This style keeps the port counts explicit, avoids “magic” port merging, and still lets you build higher-level arbitration patterns without excessive wiring.

# Using the HDL

To demonstrate that this HDL can build more than just toy examples, I built a simple RISC-V superscalar out-of-order core supporting RV32I[^5].

While doing that, I realized that using `case class` for bundle definitions isn’t much of a burden in practice.
These interfaces evolve slowly, so seldom did I have to redefine entire constructors from scratch.
Rather, this enables a much tighter LSP integration such as completion, documentation, and goto-definitions.

I also rarely had to sit around waiting for code to compile and elaborate thanks to the new elaboration engine.
Most of the time was spent on Verilator compilation.

# Conclusion

It was quite fun to learn about all sorts of advanced Scala3 features.
Using it to build a simple out-of-order core was even more fun, especially since the compile times were much shorter than Chisel.
It also made me realize that there are so many microarchitecture design decisions that I have never thought about before building this core.
I guess you can't truly understand things until you've implemented them.

---

[^1]: Writing Chisel is like tasting the best cake in the world. Once you taste it, you can never go back to something else.
[^2]: `apply`-style constructors mean you can call constructors using the class name
[^3]: Type hints help, but the LSP is forced to be either pessimistic or optimistic about type inference [pyrefly vs ty](https://blog.edward-li.com/tech/comparing-pyrefly-vs-ty/)
[^4]: The type should be bound by `HWData`. Omitted for demonstration purposes.
[^5]: Its not the most sophisticated implementation. I made a lot of simplifications in the microarchitecture just so that I can get this running in less than 2 weeks
