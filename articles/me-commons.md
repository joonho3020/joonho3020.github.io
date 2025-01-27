# Modeling datacenter-scale AI systems

How do we model the training/inference performance of datacenter scale AI systems?
We would have to use a high-level performance model tied to a backing network/switch model.
Taking the FireSim approach is unsuitable as the fidelity at which each node is modeled need not be in the RTL level.
When running RTL simulations on FPGAs, the overall simulation throughput is tanked by tying them to a synchronous network model.

Hence, a high-level model that can run in the gigahertz range is crucial.
Qemu runs at almost native speed, but does not model performance.
What we can do here is to use sampled simulation: let a fast functional simulator run ahead and execute sampled-intervals in a high-level performance model.
However, unlike a general purpose CPU, accelerators/GPUs don't have a clear architectural state.
This is a problem when sampling as we need to take state snapshots in order to initialize the performance model for each interval.

The above issue (being unable to define a clear architectural state), can be addressed by developing a new architectural specification language.
With this language, we will be able to describe the state of the machine as well as its update rules for every instruction/command.
The language will provide a way to describe registers and memory elements in an abstract manner so that implementation details such as banking can be hidden.
From a description of a machine with this language, it would be able to generate a functional simulator that has high performance and is able to run the entire software stack.
Additionally, by annotating correspondence points in between the high-level model and the description, state injection can also be streamlined.
Perhaps, as hardware is about states and how they are updated, we can further extend this as an HLS framework.
Then we can take this to the extreme were we don't even need a high-level performance model: we can perform sampled simulation using RTL.
Finally, we can generate stubs for compiler frameworks such as Exo in order to accelerate the compiler optimization process.

For the switch model, we could start with a FireSim-like constant latency/BW model.
However, it is unclear whether this simplification hides some insights that could have discovered with a better networking model.
We could build a Mess-style performance model [^1] for the switches and see how it affects the end-to-end simulation results.
Or maybe we can even build Mess-style models for these accelerators (e.g., matrix dimensions vs throughput) and use these as high level models.
Comparing the everything-Mess-style vs sampled-simulation + Mess-style networking simulation results would also be interesting as the results are completely unknown.

In summary, building a simulation system for datacenter-scale AI system leads to a wide range of research projects.
First, we can build an architectural specification language and various compiler backends to generate functional simulators, RTL, and compiler framework stubs.
Next, we can continue working on sampled simulation using RTL and come up with a systematic approach to move between simulator abstractions.
Finally, building models that are curve-fitted from real hardware measurements and using them as baselines to alternatives would lead to interesting results.

This article does not reflect the views of the organization, its affiliates, or any individuals associated with it.

[^1]: [Mess](https://arxiv.org/abs/2405.10170)
