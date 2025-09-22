+++
title = "CAMs workshop"
date = "2024-11-03"

[extra]
toc = true
+++
I ran from the Chipyard/FireSim tutorial (I wasn't presenting in the morning) to attend the computer architecture modeling and simulation ([CAMS](https://sarchlab.org/cams24)) workshop.
I recognized a few people like Trevor Carlson and Jason Lowepower.

## Morning section

The first presentation, which I was late to, was about an LLM accelerator modeling framework.
It was compared against LLM Compass[^1], another model similar to TimeLoop.
Not too interesting.

The next presentation was about using ML for bottleneck analysis, and the motivation behind it was somewhat funny.
The claim was that if you have profiling data (PMU counters) from one microarchitecture, you can use ML to transfer this data to another.
The example given was: if you have PMU counter values from Haswell, you can transfer them to Broadwell.
But if you have access to a Broadwell CPU, why not just run the software again to obtain hardware counters?
And if you don’t have access, why bother obtaining performance counters for it at all?
It’s not as if you could optimize and run your software there anyway.
Additionally, the correlation of performance counter values between architectures was quite strong: for instance, if branch predictions occurred frequently for one microarchitecture with a specific benchmark, it was also true for another.
This was entirely expected, as performance is largely determined by cache sizes and branch prediction structures (unless there are significant changes in the microarchitecture).
Overall, the motivation for this project was unclear to me.

The next talk was much better.
It was about using multithreading to parallelize GPU simulations.
The QnA was the interesting part which was about how modeling atomics affects the required synchronization granularity.
Their parallelization method involved running each SIMT core and its L1 cache for one cycle without inter-module synchronization and sending events to the shared bus after a cycle has been simulated.
The subsystem (e.g., bus, L2 cache) was run in a single thread.
Since each SIMT core and L1 cache were run in parallel without synchronization, modeling coherency became challenging: if two cores attempted to read or write to the same cache line, the core attempting to read had to check for incoming invalidation requests before completing the read by advancing a cycle.

One thing is that this probably isn't a really common event in the system and checking every cycle is probably inefficient.
Having a mechanism for canceling inflight events and rolling back would alleviate the above problem.
However, this comes with its own complexities and performance overheads.

## Afternoon section

The afternoon section started off with Gem5 updates.
It seems they built a minimalistic PyTorch port to make it runnable in gem5, although it was unclear what exactly was implemented and supported.
They also added the CHI coherence model.
The highlight was their "Novoverse" models, which are "known good configurations" for ARM Neoverse platforms.
However, instead of redesigning the microarchitecture model, it seemed like they just fiddled with the configuration parameters to match the performance counter values.
Jason straight up said they don't have an OoO core model with a decoupled frontend (maybe the Gem5 people are too busy to write this "model").
So I can only assume that they are changing things like the integer adder latency (which obviously should be combinational) just to "match the numbers".
It was quite ironic because Jason called out certain simulators as being a "random number generator", but to me, Gem5 seems no different [^2].

Then Trevor gave some updates on Sniper.
The main new feature was that it integrated some ML libraries so that you can use ML for exploring branch predictors.
He made it explicit that he does not know if ML-based branch predictors are a good idea or not, but emphasized that this exploration is "doable".
To me, it looked like he was trying to lure innocent children by waving a big lollypop at them :).
He also gave some of his thoughts on the future of simulation.
The TLDR was that we need to work on specialized frameworks that suit different user needs.
The correct approach here is to provide a new abstraction as a library so that users can build a new simulator suitable for their use.
Just like DAM [^3] :).

Then Yifan gave a presentation about Akit which is an event-driven simulation framework written in Go.
I thought it was trying to do something similar to DAM, but it was just a generic event-driven simulation framework that runs on a single thread.
Even if using coroutines for the CPU modeling part makes little sense (you have to synchronize pretty much every cycle), integrating DRAM/IO models as a coroutine could have been more interesting.

Finally, the SST guy presented some stuff, but the features that were presented were quite vanilla and it became hard to focus.

## Conclusion

I think the workshop was quite entertaining compared to other stuff (maybe I should start writing an article about all the research areas that I don't like in computer architecture).
I think the big challenge of all these simulation frameworks is that they are not validated properly and have no error bounds.
Without error bounds, studies that are built on top of it (e.g. sampling techniques, uarch changes, etc) will also have unbound errors (or in easier words, "hard to believe").
As far as I know, models used in industry are correleated directly with their silicon by extracting information out of the taped out chips (or even just in RTL simulation).
This provides them the ability to model the microarchitectural behaviors faithfully instead of just trying to match the final performance counter statistics.
However, all these academic simulators are just built without any particular microarchitecture in mind or was built a very long time ago and does not model modern CPU designs.
Hence, even if they correlate some end to end performance counter values with silicon, the underlying behavior of the model will be fundamentally different from what you will exepct in the silicon.
I think it is completely doable to perform correlation with open source RTL implementations, but it would require the modeling people to rewrite a lot of their models.
Perhaps the better option is to rethink how we write models by building a generic library that helps people build fast, easy to use simulators that can be easily validated against open source RTL implementations.

---


[^1]: https://arxiv.org/abs/2312.03134
[^2]: https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=8718630
[^3]: N. Zhang et al., "The Dataflow Abstract Machine Simulator Framework," 2024 ACM/IEEE 51st Annual International Symposium on Computer Architecture (ISCA), Buenos Aires, Argentina, 2024, pp. 532-547, doi: 10.1109/ISCA59077.2024.00046. keywords: {Tensors;Machine learning algorithms;Dams;Large language models;Memory management;Machine learning;Parallel processing;Parallel Discrete Event Simulation;Dataflow Accelerators;Modeling},
