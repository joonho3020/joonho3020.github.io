# XLS - Google's open-source HLS tool

## What is XLS?

XLS is Google's in house open-source HLS tool. Some people call this "mid level synthesis" but it is simply a transactional level HLS.
The language has three main components: functions, processes and channels.
Functions essentially describe combinational logic, channels are module ports (usually latency insensitive) and processes are a composition of functions, channels, and sequential logic.
Given a description of the circuit, the compiler can automatically pipeline it so that it doesn't fail timing when going through physical design. I'll discuss about this in detail later.
So, does XLS look appealing to you? Well, in my opinion, it really isn't all that great. So lets dive into the details on why it may not be the greatest HDL in the world.

---

## There are a few nice parts

Although I found a lot of shortcommings with this HDL, I also found some nice parts about it.

### IR

The IR design is nice and clean. First of all, they use a sea of nodes representation (essentially a graph representation) which makes pass writing much easier compared to SSA style hardware IRs. Lets look at the DCE pass as an example. As we can see, the XLS DCE pass is a simple graph traversal while in FIRRTL, the DCE pass is over 500 lines of Scala. This is mainly because to write compiler passes for a SSA style representation, you must traverse the in-memory-representation twice: first to construct a graph representation, and next to actually traverse it.

- XLS DCE pass

```cpp
int64_t removed_count = 0;
absl::flat_hash_set<Node*> unique_operands;
while (!worklist.empty()) {
  Node* node = worklist.front();
  worklist.pop_front();

  // A node may appear more than once as an operand of 'node'. Keep track of
  // which operands have been handled in a set.
  unique_operands.clear();
  for (Node* operand : node->operands()) {
    if (unique_operands.insert(operand).second) {
      if (HasSingleUse(operand) && is_deletable(operand)) {
        worklist.push_back(operand);
      }
    }
  }
  VLOG(3) << "DCE removing " << node->ToString();
  XLS_RETURN_IF_ERROR(f->RemoveNode(node));
  removed_count++;
}
```

- Scala FIRRTL DCE pass

```scala
class DeadCodeElimination extends Transform with RegisteredTransform with DependencyAPIMigration {
  private type LogicNode = MemoizedHash[WrappedExpression]
  private object LogicNode {
    def apply(moduleName: String, expr: Expression): LogicNode =
      WrappedExpression(Utils.mergeRef(WRef(moduleName), expr))
    def apply(moduleName: String, name: String): LogicNode = apply(moduleName, WRef(name))
    def apply(component: ComponentName): LogicNode = {
      // Currently only leaf nodes are supported TODO implement
      val loweredName = LowerTypes.loweredName(component.name.split('.'))
      apply(component.module.name, WRef(loweredName))
    }
    def apply(ext: ExtModule): LogicNode = LogicNode(ext.name, ext.name)
  }

    ... Many lines of code

  private def createDependencyGraph(
    instMaps:       collection.Map[String, collection.Map[String, String]],
    doTouchExtMods: Set[String],
    c:              Circuit
  ): MutableDiGraph[LogicNode] = {
    val depGraph = new MutableDiGraph[LogicNode]
    c.modules.foreach {
      case mod: Module    => setupDepGraph(depGraph, instMaps(mod.name))(mod)
      case ext: ExtModule =>
        val node = LogicNode(ext)
        if (!doTouchExtMods.contains(ext.name)) depGraph.addPairWithEdge(circuitSink, node)
        ext.ports.foreach {
          case Port(_, pname, _, AnalogType(_)) =>
            depGraph.addPairWithEdge(LogicNode(ext.name, pname), node)
            depGraph.addPairWithEdge(node, LogicNode(ext.name, pname))
          case Port(_, pname, Output, _) =>
            val portNode = LogicNode(ext.name, pname)
            depGraph.addPairWithEdge(portNode, node)
            // Also mark all outputs as circuit sinks (unless marked doTouch obviously)
            if (!doTouchExtMods.contains(ext.name)) depGraph.addPairWithEdge(circuitSink, portNode)
          case Port(_, pname, Input, _) => depGraph.addPairWithEdge(node, LogicNode(ext.name, pname))
        }
    }
    // Connect circuitSink to ALL top-level ports (we don't want to change the top-level interface)
    val topModule = c.modules.find(_.name == c.main).get
    val topOutputs = topModule.ports.foreach { port =>
      depGraph.addPairWithEdge(circuitSink, LogicNode(c.main, port.name))
    }
    depGraph
  }

  private def deleteDeadCode(
    instMap:        collection.Map[String, String],
    deadNodes:      collection.Set[LogicNode],
    moduleMap:      collection.Map[String, DefModule],
    renames:        MutableRenameMap,
    topName:        String,
    doTouchExtMods: Set[String]
  )(mod:            DefModule
  ): Option[DefModule] = {
      ... Many more lines of code
  }

  def run(state: CircuitState, dontTouches: Seq[LogicNode], doTouchExtMods: Set[String]): CircuitState = {
     ... Even more lines of code
  }

  def execute(state: CircuitState): CircuitState = {
    val dontTouches: Seq[LogicNode] = state.annotations.flatMap {
      case anno: HasDontTouches =>
        anno.dontTouches
          // We treat all ReferenceTargets as if they were local because of limitations of
          // EliminateTargetPaths
          .map(rt => LogicNode(rt.encapsulatingModule, rt.ref))
      case o => Nil
    }
    val doTouchExtMods: Seq[String] = state.annotations.collect {
      case OptimizableExtModuleAnnotation(ModuleName(name, _)) => name
    }
    val noDCE = state.annotations.contains(NoDCEAnnotation)
    if (noDCE) {
      logger.info("Skipping DCE")
      state
    } else {
      run(state, dontTouches, doTouchExtMods.toSet)
    }
  }
}
```

Another good decision that they made is to not have any compiler dialects. Dialects usually fragments the compiler infrastructure and kills interoperability of the passes.

### Generic tooling side 

There are also some good features in XLS in terms of generic tooling.

- First of all, the inline testbench was pretty lightweight and easy to use (it is definitely better than writing verilog testbenches).

- In XLS you can "JIT" your design into native code to perform functional simulation (a benefit of the custom compiler approach). This was fast and useful for initial pipecleaning of the design. Also, using print statements to debug code was another benefit.

- Bazel as the main build system. Bazel's cacheing & incremental compilation support provided a very quick edit-run-debug loop (I guess this is a compliment towards Bazel though).

---

## XLS pitfalls

There are a couple of bad design decisions that renders XLS useless. Lets take a look at each one.

### Abstraction is all that matters

The biggest problem of XLS is that the abstraction at which this language is built on is "wrong"[^1]. If you take a look at traditional HLS tools (e.g. Catapault or System-C), the biggest advantage they have over hand-written RTL is that it enables developers to work on higher level abstractions. This usually means that HLS tools have some sort of control flow synthesis which frees the designer from having to reason about the control path in a cycle-by-cycle, bit-by-bit manner. Automating this processes alleviates a huge burden as debugging the control flow is where hardware designers spend most of their time. **However, XLS draws the abstraction boundary where they don't support control flow synthesis.** What this means is that if you have an complicated FSM that you want to write, you cannot describe the circuit in an imperative style language and rely on the compiler to synthesize the control logic. Rather, you have to explicitly instantiate all the hardware state that is required to control the FSM and make sure it is doing what you expect it to do. Lets look at an example. The below code block is a GCD module expressed in XLS. As you can see below, all the necessary state to express the FSM (i.e. `GCDState`) has been explicitly instantiated by the programmer. You can also see that the `next` function looks very similar to an FSM written using RTL. This is definitely not what we want from an HLS tool.

```rust
struct GCDState<N: u32> {
  fsm: u1,
  gcd: uN[N],
  tmp: uN[N],
}

proc GCD<N: u32> {
  type UInt = uN[N];

  io_x: chan<UInt> in;
  io_y: chan<UInt> in;
  io_gcd: chan<UInt> out;

  init {
    GCDState {
      fsm: u1:0,
      gcd: UInt:0,
      tmp: UInt:0,
    }
  }

  config(
    x: chan<UInt> in,
    y: chan<UInt> in,
    gcd: chan<UInt> out
  ) {
    (x, y, gcd)
  }

  next(tok: token, state: GCDState) {
    if (state.fsm == u1:0) {
      let (tok_x, x) = recv(tok, io_x);
      let (tok_y, y) = recv(tok, io_y);
      let tok = join(tok_x, tok_y);
      GCDState{ fsm: u1:1, gcd: x, tmp: y }
    } else {
      let gcd = if (state.gcd > state.tmp) { state.gcd - state.tmp }
                else { state.tmp };
      let tmp = if (state.gcd > state.tmp) { state.tmp }
                else { state.tmp - state.gcd };
      let fsm = if (tmp == UInt:0) { u1:0 }
                else { u1:1 };
      let tok = if (fsm == u1:0) { send(tok, io_gcd, gcd) }
                else { tok };
      GCDState{ fsm: fsm, gcd: gcd, tmp: tmp }
    }
  }
}
```

An abstraction that XLS does have is communication channels which are basically latency insensitive ports. By abstracting away these constructs, backpressure bugs can be avoided by design [^2]. However, logic synthesis for latency insensitive interfaces aren't really helpful compared to having control flow synthesis. Imagine a case where bus responses arrive out of order. Then it is still up to the designer to manually write the control logic to handle the responses correctly. Furthermore, there are cases where the designer wants to use ports that aren't latency insensitive, but wants combinational feedback paths (e.g., priority encoders). It is difficult to express these types of logic using XLS channels. The hardware designers are now forced to write blocks that are suboptimal as it has to waste cycles performing ready valid handshakes when it can get away with combinational logic.

One benefit that the channel abstraction has is in the testbench. The XLS abstraction allows the programmer to interact with each port without having to explicitly perform ready-valid handshakes which is a slight improvement over the RTL abstraction. For instance, in the below `Tester` example, we can interact with the dut with only `send` and `recv` functions. However, the abstraction is still not high enough to have a huge benefit over the RTL abstraction.


```rust
#[test_proc]
proc Tester {
  terminator: chan<bool> out;

  io_x: chan<u32> out;
  io_y: chan<u32> out;
  io_gcd: chan<u32> in;

  init {
  }

  config(terminator: chan<bool> out) {
    let (x_p, x_c) = chan<u32>("x");
    let (y_p, y_c) = chan<u32>("y");
    let (gcd_p, gcd_c) = chan<u32>("gcd");

    spawn GCD<u32:32>(x_c, y_c, gcd_p);
    (terminator, x_p, y_p, gcd_c)
  }

  next(tok: token, state: ()) {
    let tok_x = send(tok, io_x, u32:8);
    let tok_y = send(tok, io_y, u32:12);
    let tok = join(tok_x, tok_y);
    let (tok, gcd) = recv(tok, io_gcd);
    assert_eq(gcd, u32:4);
    send(tok, terminator, true);
  }
}
```


It seems like for the abstraction that XLS is taking, the compiler is doing all the "easy work" of taking care of latency insensitive interfaces while defering all the "hard work" to the designer. This probably isn't what most people expect from a good compiler.

### You won't be adding faster than an adder (Dr. Quinnel's 2nd law)

One main selling point of XLS is their automatic pipelining capabilities. They basically have a delay estimation model for a particular technology (ASAP7 is currently supported), and automatically inserts pipeline stages to reduce critical path lengths. This sounds nice but actually doesn't make a lot of sense. For latency insensitive boundaries, there will be queues in between the ports which will probably cut combinational logic between the blocks. For combinational logic, the synthesis tool will do a much better job at retiming anyways. Modern synthesis tools are quite advanced and it is unlikely that the XLS compiler can come up with an optimization for any combination logic that beats it (which is basically the 2nd law of Dr. Quinnel).

You may still argue that you can cut the iteration time of fixing critical paths using XLS. Unfortunately, even if you can iterate very quickly using the delay model without going through synthesis, I don't think there is a huge benefit when you're delay model isn't very accurate (and it never will be compared to synthesis tools).

The below github issue is an example where the XLS QoR prediction causes problems. As XLS is trying to pipeline the design in the HDL frontend, changes in how the frontend is written affects the estimated QoR of the circuit. However in reality, the synthesis tool will take care of these problems for you regardless of how the frontend is written. In conclusion, this issue is just a aftermath of attempting to perform premature optimization.

- [XLS github issue - premature optimization is the real issue](https://github.com/google/xls/issues/1482)

### Building a custom compiler is (usually) not a good idea

I'll now move on to talk about some of their software engineering decisions. The XLS team had the courage to build a custom compiler from scratch which is a double edged sword. It gives you all the freedom to do whatever you want which can potentially lead to good ergonomics and enable native language level simulations. On the flip side, it is **a lot** of work to get everything in place.

I think in XLS (or in my futile attempt to use it), the disadvantages seemed to outweigh the benefits. This is the list of limitations that I felt from a purely software engineering perspective.

- Even though the XLS frontend (DXLS) is statically typed, there isn't a clear separation between the hardware types from the host types. A `u32` can both mean a wire of 32 bits or a `uint32_t` which is very confusing. Also, if you can't distinguish the host types from hardware types, you can't catch bugs caused by the mixed use of variables for hardware description and host language which renders the static type system rather useless for a language specialized for hardware design.

- The modules are parameterized using type parameters, not normal function arguments (`proc GCD<N: u32>` in the above GCD example). Although programmers can compute arbitrary arguments from other arguments and call functions, it felt less ergonomic compared to when you place these parameters as function arguments.

- The compiler doesn't support automatic bitwidth inference so the programmer has to specify the type of each wire everywhere. This makes the code super verbose and ugly. Some might argue that width inference isn't crucial, but if you have used an HDL with width inference (e.g. Chisel) before, you understand how much easier it is to write code because it frees you from having to think about all these nit details about your design.

- They implemented a standard library in order to perform simple things like reading files (which is required to for writing testbenches). Whereas if they used an embedded DSL, opening files that contains testbench data would have been a piece of cake. Although this doesn't matter to the end user, it must have been a lot of work for the engineers.

- Miscellaneous compilation bugs. I wasn't able to compile a `for` statement while trying to create a multi-banked SRAM in my design. It seems like other people tried doing the same thing without much success. For instance, if you look at the [XLS ZStd implementation](https://github.com/antmicro/xls/blob/76e650ac9030757a9960045931007a56311a1fca/xls/modules/zstd/sequence_executor.x#L1337), the programmer had to hand-unroll the SRAM banks because the `for` statement was broken (you can also see how verbose the code is due to the lack of type inference).

In my opinion, I think they would have had a much easier time if they took a embedded DSL approach because you get a lot of the above things for free: generic type inference, fewer compiler bugs, buildtools, and all the existing software libraries for the host language. However, I do understand that this project is still work in progress and these software limitations can be overcome with enough engineering effort. I look forward for the improvements that will come.

## Fun facts

One interesting aspect of this project is that there was a [Hacker News article](https://news.ycombinator.com/item?id=24354083) about this four years ago. If you read the comments, a lot of them mention the same problems that I stated in my article such as lack of control flow synthesis and drawing bad abstraction boundaries.

- "For those that aren't familiar, control flow - or non "Directed Acyclical graphs" are the hard part of HLS. This looks like a fairly nice syntax compared to the bastardisations of C that Intel and Xilinx pursue for HLS but I'm not sure this is bringing anything new to the table."

- "They describe it as HLS, and it definitely looks like HLS to me. But maybe we have different definitions. Either way, it seems to be targeting a strange subset of problems: it doesn't look high level enough to be easy to use for non-hardware designers (I don't think this goal is achievable, but it is at least a worthy goal), and it doesn't seem low-level enough to allow predictable performance."

- "Take this language for example - it cannot express any control flow. It's feed forward only. Which essentially means, it is impossible to express most of the difficult parts of the problems people solve in hardware. I hate Verilog, I would love a better solution, but this language is like designing a software programming language that has no concept of run-time conditionals."


My guess is that there wasn't a real hardware engineer in the XLS team to guide them in the right direction. Still, it is unfortunate that the XLS team just decided to disregard feedback when they had the chance of rethinking things from ground up...

---

## Conclusion

All in all, I don't think XLS is suitable for initial prototyping of designs (let alone for tapeouts). The abstraction isn't high enough to have a productivity edge over RTL, and the generated RTL will have lower QoR compared to hand written RTL implementations. The automatic pipelining isn't really helpful in most cases (especially when it probably isn't accurate), and the ergonomics of the frontend language doesn't help with productivity either. Also, it is difficult to perform integration tests in a full SoC context because you have to write gluecode to stitch the generated verilog into the SoC as well (although this is a problem of most HLS tools and a potentially interesting research question).

Nevertheless, I do appreciate that they tried building a new hardware design language from scratch and tried out new abstractions. Bringing in software techniques into hardware design is definitely something that researchers should work on and have the potential to unlock new possibilities. Admittedly, this is a very tricky field as you need a person with background on both hardware design and programming languages. What we should do is to learn from past mistakes and start over: do a better job next time. When building tools, there is always room for improvement.

[^1]: The definition of "correct" abstraction boundaries can differ from situation to situation. But in this case, it is simply wrong in all cases.
[^2]: Technically, backpressure bugs can still happen but I'm just trying to be nice here.

---

## Citations

- [XLS github issue - premature optimization is the real issue](https://github.com/google/xls/issues/1482)
- [XLS ZStd implementation](https://github.com/antmicro/xls/blob/76e650ac9030757a9960045931007a56311a1fca/xls/modules/zstd/sequence_executor.x#L1337)
- [Hacker News article](https://news.ycombinator.com/item?id=24354083)
