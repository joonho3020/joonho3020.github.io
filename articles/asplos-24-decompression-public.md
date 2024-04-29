# ASPLOS 2024 Notes

## XiangShang tutorial

### XiangShang infrastructure
- They had some cool/interesting features and tools built around their infrastructure which was quite impressive
- difftest
    - They run a functional simulation (in house) alongside RTL simulation to check for functionality
    - The RTL sends messages to the functional simulation about certain state updates, and the functional simulator will update its state to what the RTL state should look like in the next step
    - If they diverge, the RTL simulation will pause
    - They also added support to extract out waveforms for just a tiny piece of the timeframe before the bug appears
        - They would fork the simulation thread, and the forked thread will run behind the main thread
        - Once the main thread encounters a bug, it will send a signal to the forked thread to start recording the waveform
    - One thing was that their verilator build time was absurdly long (they used a cached version of the simulator, but it took a pretty long time to build their actual thing which was called `MinimalConfig`)
- Simpoint
    - They perform simpoint by generating checkpoints using functional simulator
    - The checkpoints can be used by both gem5 & RTL
    - They seemed to have a well correlated gem5 configuration vs RTL
    - They checkpoints are binaries that contains a custom region called gCkpt(?) which contains information about the arch state
    - They can perform restoration by having a small code snippet that sets all the architectural states to the ones written the the gCkpt region (they don't need a custom harness to inject state and it works regardless of the uarch, i felt like this was what tidalsim should do in the long run as it seems more robust)
    - 5.5 hours to run the entire spec (200 million instructions per interval) : how many machines/cores are they running in parallel?
    - Don't care about functional warmup, only detailed warmup where the amount can be controlled
    - And of course, they can boot Linux using these checkpoints
- Constantin
    - Since their elaboration time takes so long, they need a smarter way of sweeping through parameters (e.g, core with, branch predictor SRAM size, number of MSHR entries etc)
    - They can punch out control signals to the top that enables them to control the amount of hardware resources that are actually used during runtime
    - So all they have to do is build a configuration with maximum resources and sweep through the parameters
    - And using this, they were able to achieve a 1.44% increase in IPC by fine tuning the TAGE branch predictor
- Verification infrastructure
    - They claim that they have industry grade verification support
    - They can save tilelink transactions into a SQL database so that they can query the requests and resposes later during debuggging
- Performance analysis
    - They have 10K performance counters in their designs lol
    - They can dump these performance results out, and have a bunch of post processing scripts that provide them with human readable information (e.g. top down analysis breakdowns)

### Their strenghts and weaknesses
- Their out of order cores are pretty impressive and is closer to an industry grade core than an academic one (although the area and power consumptions of the core is pretty large, I'm certain that they will be able to cut that down)
    - They come up with 5~10 uarch optimizations per generation (2 years).
- They even support the hypervisor extension which is crazy
- Their functional simulator (NEMU) is the most impressive part of their infrastructure by far
    - Their cosimulation infrastructure with NEMU is impressive (they are checking more states than just architectural state: I'm not sure if this method is generalizable though. seems like you have to write a specific functional simulator for every RTL generation??)
    - The ability to generate checkpoints that can be just used by any simulator (gem5 or RTL) was also impressive
    - Also compared with spike, NEMU compiles much quicker and runs comparably fast
- My impression was that these people all have a common goal (increasing the IPC of a OoO core) and providing it to the chinese government and was working hard to achieve it. And I think they are quite successful at doing this.
    - Their engineering efforts are quite inspiring. Given some basic design tools and design (Chisel and BOOM), they are very good at augmenting it for their specific needs.
    - However, seems like they aren't doing anything that is "creative or insighful" per say. Their simpoint clustering and embedding strategies are pretty vanilla, their top down analysis is also something that is well known, and the verification infrastructure seems like a engineering feat.
    - Almost an IP company
    - Funny thing that was memorable. One guy asked them if their cores are for academia or industry. The presenter said : "we don't know, it can be used for both".

### Should we try to replicate this environment?
- I think we can't catch up to match IPC, or even try (doesn't mean that we shouldn't work on microarchitecture, we need microarchitects)
- We need to think just a little bit more and try to innovate on the methodology
    - Simulation techniques (better sampling, cluster, embedding, end to end metric awareness)
    - Performance analysis (profiling, bottleneck analysis, come up with ways of filtering out useful info from mundane ones)
    - And rethink the agile design methodology altogether

## LATTE

### Our talk
- The talk went okay. People seemed to have enjoyed the talk.
- Couple of questions that I remember:
    - A CIRCT guy asked : why not just use CIRCT, it supports all the mixed abstractions you talked about. AFAIK, simulation is still done at the RTL level abstraction, and they don't have RTL level primitives that we would like to support. For example, there is no "NOT" primitive in circt because it can be expressed by a "XOR" operation. Also CIRCT's main frontend language is Chisel.
    - Olivia asked : modeling actually helps hardware designers, but you argue that there should be no modeling. I agree that modeling is helpful (when you have a separate team to do it for you). But our arguement is that when you have a lean team and need to get a chip out the door, or just want to build something that works, it is better to make RTL writing easier. Also, in the future, it would be ideal if we can natively incorporate models into the system and refine that into RTL.
    - Rachit raised a point about the "spec first" vs "implementation first" approach. Of course, the "spec first" approach just isn't how you build big systems. Writing specs will slow you down unnecessarily, and trying to formally verify properties of your circuit only works for small parts of your design and thus is not scalable. None of the open source SoC design frameworks out there used the "spec first" approach. But this is not to say that formally verifying parts of your design isn't useful. Trying to verify a large SoC using DV would be very painful as you need to come up with smart test codes that exercise certain behaviors of your design. To do that for every single block of your SoC module seems painful. Maybe you can perform formal on small parts of the design and random tests for the full design to find integration bugs?

### Discussion w/ Jose Renau
- Q : Plans to incorporate the LiveHD repo into a SoC design framework?
    - A: Have to perform some code cleanup because it isn't 100% stable. Maybe 98% stable, but need some more polishing for it to be actually used.
- Q: Plans to extend incremental synth to incremental PnR?
    - A: Hacking yosys is kind of difficult. Bugs might pop up here and there because the open source flows aren't that stable. Also hard to get papers for students.
- Q: Why can't tools predict critical paths and just tell the users instead of pushing through?
    - A: We can try training a model or use some heuristics to make predictions, but he thought that having incremental synthesis is a bigger benefit than critical path prediction. Just make running synthesis faster and you don't have this problem.
    - Although I thought these two approaches are orthogonal and can help each other? But I do agree that incremental synthesis is more important than this.
- Q: I heard that you were working on LLM related things?
    - A: Train LLMs to emit english from verilog input. Then you can also make them generate verilog given english. What you can do now is have python code + english and feed that to the LLM to generate RTL.
    - I feel like just using verilog as an input to LLMs has limitations because all the LLM can extract out is static information about the circuit. Maybe feeding in the RTL + simulation snapshots can help train LLMs, but I'm not an expert in this so...
- Q: IR implementation details? Where are the speedups comming from vs CIRCT?
    - Parallelism : topological/hierarchical parallelism which is managed by the compiler framework. Not much perf benefit for passes that have cross-module ref. Maybe we can remove the notion of modules altogether?
    - Locality : Most nodes can fit in a single cacheline with its neighboring nodes (RTL graph has a limited number of fanouts: makes sense because you don't want high fanout wires everywhere in your design)

### Some other talks
- Memory consistency thing : Didn't really get the point. If you have a ISA, you know your MCM before starting implementation. I think what could be done with this DSL is define valid transactions given a MCM spec, and use it to generated runtime assertions. However, wasn't sure if the language supported transactions like speculative loads.
- Mojo : python frontend for CIRCT. Can call C-python to run python code or call into their native interpreter for their custom DSL that abstracts away CIRCT primitives. Exposes APIs to the user so that they can focus on making better scheduling decisions which enables them to generate code that outperforms hand written kernels. 
- Stanford CGRA stuff 
    - cute trick to add/remove pipeline registers in CGRAs. Works because they know the CGRA architecture.
    - unified virtual buffer : it is just generating HW for affine access. Works only when the address accesses are statically scheduled
- Gatech compiler stuff
    - tightly integrate the SW compiler for a given HW design to generate code that maps well to HW
    - specific to statically schedulable kernels
