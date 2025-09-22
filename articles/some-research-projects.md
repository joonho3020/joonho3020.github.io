# Some research projects

I'll be graduating in 2026 May so we can do research together for a year.
If you are an undergrad (or early stage grad student) in UC Berkeley and interested in any of these projects, feel free to send me an email.

## Concrete Implementation Projects

- Adding supervisor mode to a Rust based RISC-V functional simulator
    - [rusty-functional-sim](https://github.com/euphoric-hardware/riscv-functional-sim)
    - Currently, this only works for baremetal. We want to augment this in order to support supervisor mode and thus boot an OS
    - Will teach you about intricacies of the RISC-V ISA and some OS internals as well
- Implementing a cranelift backend for RTL simulations
    - I have a custom HW intermediate representation (separate from the CIRCT/FIRRTL infra)
    - We can directly generate RTL simulations of this by emitting cranelift IR
    - Major benefit over Verilator would be in compile times, but we can work on performance optimizations later on such as vectorization and deduplication
- Improving the microarchitecture of a processor based RTL simulation engine
    - Add bypass paths between a subgroup of processors to improve performance
    - Add simultaneous multithreading (SMT) support for the processors by splitting the instruction memory into two halves and adding port arbitration
- Porting tinygrad/triton backend for gemmini/rvv (?)
    - Think whether there is there are abstractions that are missing during this project
    - Obtain understanding of ML compilers
- Reducing the overhead of sampling based profilers - shadow stack impl in rocket
    - Related blog posts
        - [shadow-stack for go](https://blog.felixge.de/blazingly-fast-shadow-stacks-for-go/)
        - [redhat, stack unwinding overhead is a trap for sampling based profilers](https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/auth?client_id=rhd-web&redirect_uri=https%3A%2F%2Fdevelopers.redhat.com%2Farticles%2F2024%2F10%2F30%2Flimitations-frame-pointer-unwinding&state=44f7dca1-43a0-40c5-b1f4-84348aa7dd67&response_mode=fragment&response_type=code&scope=openid%20api.dxp_portals.developers&nonce=5d857d94-4b4d-4c3d-99b5-5b6b951566a7&prompt=none&code_challenge=seDrE632essMAuVdjckKFFZgiZG4AAFgYQLVpgW_A24&code_challenge_method=S256)
    - Motivation is to reduce profiling perturbation via adding hardware support for stack unwinding
        - Step zero would be to understand how linux perf works under the hood by heart
        - Next step is to implement this in spike & linux
        - Final step would be to implement this in RTL, but this can be painful and would involve using firesim. this can be a stretch goal
    - [Detailed project description here](./shadow-stack-profiler.md)
- Building a hardware module for SoC event tracking
    - [Profiling hello world](https://queue.acm.org/detail.cfm?id=3291278)
        - First and foremost, you must see to understand and optimize. Otherwise you will be mislead into investigating irrelevant things (i.e., the streetlight effect where you are searching under the streetlight, not actually where your missing keys are!)
        - Must track every event in the system to understand causality. If you don't understand causality, you can't optimize. Can't just track user space events as they are only a small part of the system! Many things happen between userspace execution
        - Interference and thread migrations between processes are a real problem. To understand the system, you must trace every system-wide event!
        - When tracing, no small event is small enough to ignore. They can actually add up becoming a signficant bottleneck
    - [Hardware assisted tracing](https://yosefk.com/blog/profiling-in-production-with-function-call-traces.html#hardware-assisted-tracing)
    - Current trace based SoC intraspection is not useful for understanding the behavior of interpretted/runtime managed languages. The instructions will just point to the interpretter loop, or the JIT'ed code which you have no idea on how it corresponds to the original source. Hence we need a different approach when trying to get information about these programs from the SoC as a sidechannel
    - Should be able to pull out events such as page faults, context switches, interrupts, IO, and user annotated events
- Building a toy hdl using nim
    - Nim has a...
        - Statically typed
        - Powerful macro system
        - Can pass around closures fairly easily
        - Fast compiled language with hot reloading
    - Maybe an alternative is mojo?
        - [As of now, there is no way of implementing custom operators](https://docs.modular.com/mojo/manual/operators/#implement-operators-for-custom-types)
- Improving the BOOM frontend bottlenecks
    - Currently, BOOM can only fetch consecutive basic blocks at a time. For high performance cores, need to be able to fetch multiple (normally 2) non-consecutive BBs at a time. Modify the boom frontend to handle this. It will require intrusive changes to the boom mid end too though
    - Modify the boom I-cache so that we can perform fetches from straddled cachelines (modifying existing complex RTL is not easy, but this is a well scoped microarchitecture project)
        - [Initial implementation here](https://github.com/joonho3020/riscv-boom/tree/cacheline-cross)
            - Adds an additional read port in the I-cache tag array
        - Next steps
            - Perform more aggressive DV
            - Update the branch predictor to handle predictions across cacheline boundaries. Currently, the predictor assumes a fetch bundle never spans multiple cachelines, which leads to mispredictions when a branch lies in the next cacheline (even if it hits in the icache)
- Building an OoO performance model (although I'm not a huge fan of performance models...)
    - Good for building a strong understanding of OoO execution
    - Feed in traces from functional simulator (rusty-spike) into this performance model (probably use rust???)
    - Could work as a steppingstone for investigating a systematic RTL/model correlation approach via event annotations
- Building benchmarks for web applications
    - Cross compilation into RISC-V works well for Golang so searching/porting them to RISC-V and running them on Spike, FireSim would be super cool
    - Combine this with profiling and I'm sure you will find interesting events happening
    - Push request rate until response latency surges. Precisely describe why
    - How do modern OoO cores react to highly concurrent applications?

## Ideas & Open Ended Projects

- ML guided graph partitioning for the RTL emulator compiler
    - Use ML to find "good" graph partition points
    - Work with existing graph partitioners and get a touch on ML as well
- Using e-graphs for combinational optimization for RTL graphs
    - Can see what benefit we can get when we have finer-grained control over the generated gate level netlist for emulation
- Mess for ML accelerators/GPUs/NICs for system modeling
- Incremental synthesis - graph hashing and store in DB
    - hook it up with vtr9 and actually build bitstreams with it
- Profiling - breaking down the sources of perturbation
- Uarch optimization - building a trace analyzer tool
    - load store address/value analysis
    - renaming capacity/dependency chain analysis
    - basic block frequency
- Building a programmable MIMD machine + compiler
    - Research question would be this: is there room for introducing another general purpose programmable architecture for fine-grained parallelism?
    - In order to address the above question, we need to answer this: how much thread divergence in an SIMT machine has to exist in order for MIMD machines to be able to amortize the fetch/decode/dispatch overhead?
