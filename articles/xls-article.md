# XLS - Google's open-source HLS tool

## What is XLS?

XLS is Google’s in-house open-source HLS tool. Some refer to it as “mid-level synthesis,” but it is more accurately described as a transactional-level HLS. The language consists of three main components: functions, processes, and channels.

Functions essentially describe combinational logic, channels represent module ports (usually latency-insensitive), and processes are a composition of functions, channels, and sequential logic. Given a circuit description, the compiler can automatically pipeline it to ensure it meets timing requirements during physical design. I’ll discuss this in detail later.

So, does XLS seem appealing to you? Personally, I don’t find it to be all that impressive. Let’s explore why it might not be the best HDL available.

---

## There are a few nice parts

Although I found a lot of shortcommings with this HDL, I also found some nice parts about it.

### IR

The IR design is nice and clean. First of all, XLS uses a sea-of-nodes representation, which is essentially a graph representation. This approach makes writing passes much easier compared to SSA-style hardware IRs. Let’s take the DCE (Dead Code Elimination) pass as an example. In XLS, the DCE pass is a simple graph traversal, whereas in FIRRTL, the DCE pass spans over 500 lines of Scala code. This complexity arises because, with an SSA-style representation, you must traverse the in-memory representation twice: first to construct a graph representation, and then to actually traverse it.

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

Another good decision they made was not to include any compiler dialects. Dialects typically fragment the compiler infrastructure and hinder the interoperability of passes.

### Generic tooling side 

XLS also offers some strong features in terms of generic tooling.

- First of all, the inline testbench is quite lightweight and easy to use—definitely an improvement over writing Verilog testbenches.

- In XLS, you can “JIT” your design into native code to perform functional simulation, which is a benefit of the custom compiler approach. This method is fast and useful for the initial pipecleaning of the design. Additionally, the ability to use print statements for debugging is another advantage.

- Bazel is used as the main build system. Its caching and incremental compilation support provide a very quick edit-run-debug loop (though this is more of a compliment toward Bazel).

---

## XLS pitfalls

There are a few poor design decisions in XLS. Let’s take a look at each one.

### Abstraction is all that matters

The biggest problem with XLS is that the abstraction on which this language is built is fundamentally “wrong”. Traditional HLS tools (e.g., Catapult or SystemC) have a significant advantage over hand-written RTL by allowing developers to work at higher levels of abstraction. These tools typically support control flow synthesis, freeing designers from having to reason about the control path on a cycle-by-cycle, bit-by-bit basis. Automating this process alleviates a huge burden, as debugging control flow is where hardware designers spend much of their time.

However, XLS sets its abstraction boundary by not supporting control flow synthesis. This means that if you have a complex FSM (Finite State Machine) to implement, you cannot describe the circuit in an imperative-style language and rely on the compiler to synthesize the control logic. Instead, you must explicitly instantiate all the hardware state required to control the FSM and manually ensure it behaves as expected.

Let’s consider an example. The code block below is a GCD module expressed in XLS. As you can see, all the necessary state to express the FSM (i.e., GCDState) has been explicitly instantiated by the programmer. Moreover, the next function closely resembles an FSM written in RTL, which is definitely not what we want from an HLS tool.


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

One abstraction that XLS does provide is communication channels, which are essentially latency-insensitive ports. By abstracting away these constructs, XLS helps avoid backpressure bugs by design [^1]. However, logic synthesis for latency-insensitive interfaces is not as beneficial as having control flow synthesis. For example, if bus responses arrive out of order, it remains the designer’s responsibility to manually write the control logic to handle the responses correctly.

Moreover, there are cases where designers need to use ports that are not latency-insensitive but require combinational feedback paths (e.g., priority encoders). Expressing this type of logic using XLS channels is challenging. Designers are then forced to write suboptimal blocks that waste cycles performing ready-valid handshakes when combinational logic could suffice.

One benefit of the channel abstraction is its use in testbenches. The XLS abstraction allows the programmer to interact with each port without having to explicitly perform ready-valid handshakes, which is a slight improvement over the RTL abstraction. For example, in the `Tester` example below, we can interact with the DUT using only `send` and `recv` functions. However, the abstraction is still not high enough to provide a substantial advantage over the RTL abstraction.


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

One main selling point of XLS is its automatic pipelining capabilities. It uses a delay estimation model for a particular technology (ASAP7 is currently supported) to automatically insert pipeline stages and reduce critical path lengths. While this sounds promising, it may not be as effective as it seems. For latency-insensitive boundaries, queues between the ports can introduce additional stages that will cut combinational logic between blocks. For combinational logic, synthesis tools generally perform better at retiming. Modern synthesis tools are highly advanced, and it is unlikely that the XLS compiler can achieve an optimization for any combinational logic that surpasses what these tools offer (which is basically the 2nd law of Dr. Quinnel).

You might argue that XLS can reduce the iteration time for fixing critical paths. While it’s true that you can quickly iterate using the delay model without going through synthesis, this advantage is limited if the delay model isn’t very accurate. In practice, the delay model will never match the accuracy of synthesis tools, which limits the overall benefit.

The GitHub issue below is an example where the XLS QoR (Quality of Results) prediction leads to problems. Since XLS attempts to pipeline the design in the HDL frontend, changes in how the frontend is written can affect the estimated QoR of the circuit. However, in reality, the synthesis tool will address these issues regardless of the frontend’s implementation. In conclusion, this issue illustrates the pitfalls of premature optimization.

- [XLS github issue - premature optimization is the real issue](https://github.com/google/xls/issues/1482)

### Building a custom compiler is (usually) not a good idea

Now, let’s discuss some of their software engineering decisions. The XLS team took the bold step of building a custom compiler from scratch, which is a double-edged sword. On one hand, it provides the freedom to design according to specific needs, potentially leading to better ergonomics and enabling native language-level simulations. On the other hand, it involves a significant amount of work to get everything set up and functioning properly.

In my experience with XLS (or perhaps in my unsuccessful attempt to use it), the disadvantages seemed to outweigh the benefits. Here is a list of limitations I encountered from a purely software engineering perspective:

- Modules in XLS are parameterized using type parameters, rather than standard function arguments (e.g., `proc GCD<N: u32>` in the GCD example above). Although programmers can compute arbitrary arguments from other arguments and call functions, this approach feels less ergonomic compared to placing these parameters as function arguments.

- The compiler does not support automatic bit-width inference, so the programmer must specify the type of each wire explicitly. This requirement makes the code verbose and cumbersome. While some might argue that width inference isn’t crucial, those who have used an HDL with width inference (e.g., Chisel) will understand how much easier it is to write code without having to manage these intricate details of the design.

- They implemented a standard library to handle basic tasks like reading files, which is necessary for writing testbenches. In contrast, if they had used an embedded DSL, handling files containing testbench data would have been much simpler. While this may not impact the end user significantly, it likely required a considerable amount of effort from the engineers.

- Miscellaneous compilation bugs were also a problem. I encountered issues compiling a `for` statement while trying to create a multi-banked SRAM in my design. It appears that others have faced similar difficulties. For example, in the [XLS ZStd implementation](https://github.com/antmicro/xls/blob/76e650ac9030757a9960045931007a56311a1fca/xls/modules/zstd/sequence_executor.x#L1337), the programmer had to hand-unroll the SRAM banks because the `for` statement was broken (this example also highlights how verbose the code becomes due to the lack of type inference).

In my opinion, they would have had an easier time with an embedded DSL approach, as it would provide many benefits: generic type inference, fewer compiler bugs, build tools, and access to existing software libraries for the host language. However, I understand that this project is still a work in progress, and these software limitations can be addressed with enough engineering effort. I look forward to the improvements that will come.

## Fun facts

One interesting aspect of this project is that there was a [Hacker News article](https://news.ycombinator.com/item?id=24354083) about this four years ago. Many comments on that article mention the same problems I’ve highlighted, such as the lack of control flow synthesis and poor abstraction boundaries.

- "For those that aren't familiar, control flow - or non "Directed Acyclical graphs" are the hard part of HLS. This looks like a fairly nice syntax compared to the bastardisations of C that Intel and Xilinx pursue for HLS but I'm not sure this is bringing anything new to the table."

- "They describe it as HLS, and it definitely looks like HLS to me. But maybe we have different definitions. Either way, it seems to be targeting a strange subset of problems: it doesn't look high level enough to be easy to use for non-hardware designers (I don't think this goal is achievable, but it is at least a worthy goal), and it doesn't seem low-level enough to allow predictable performance."

- "Take this language for example - it cannot express any control flow. It's feed forward only. Which essentially means, it is impossible to express most of the difficult parts of the problems people solve in hardware. I hate Verilog, I would love a better solution, but this language is like designing a software programming language that has no concept of run-time conditionals."


My guess is that there wasn’t a hardware engineer on the XLS team to guide them in the right direction. It’s unfortunate that the XLS team chose to disregard feedback when they had the opportunity to rethink the project from the ground up.

---

## Conclusion

Overall, I don’t think XLS is suitable for initial prototyping of designs, let alone for tapeouts. The abstraction level isn’t high enough to provide a productivity advantage over RTL, and the generated RTL will have lower QoR compared to hand-written RTL implementations. The automatic pipelining feature is not particularly helpful in most cases, especially when its accuracy is questionable. Additionally, the ergonomics of the frontend language do not enhance productivity. Integration testing in a full SoC context is also challenging because you need to write glue code to integrate the generated Verilog into the SoC, although this issue is common among many HLS tools and could be a potential area for research.

Nevertheless, I appreciate their effort in building a new hardware design language from scratch and exploring new abstractions. Integrating software techniques into hardware design is a valuable area for research and has the potential to unlock new possibilities. Admittedly, this is a challenging field that requires expertise in both hardware design and programming languages. We should learn from past mistakes and aim to do better next time. There is always room for improvement when developing tools.


[^1]: Technically, backpressure bugs can still happen.

---

## Citations

- [XLS github issue - premature optimization is the real issue](https://github.com/google/xls/issues/1482)
- [XLS ZStd implementation](https://github.com/antmicro/xls/blob/76e650ac9030757a9960045931007a56311a1fca/xls/modules/zstd/sequence_executor.x#L1337)
- [Hacker News article](https://news.ycombinator.com/item?id=24354083)
