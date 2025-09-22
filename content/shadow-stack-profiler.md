+++
title = "Using Shadow Stacks to Reduce Performance Perturbation in Sampling Profilers"
date = "2025-09-15"

[extra]
toc = true
+++
## Project Overview

Sampling based profilers such as `perf`, collects call-stacks periodically to provide information about the frequency of the function calls.
In order to collect the call-stack information, `perf` sets up a timer interrupt.
When the interrupt line is raised, the thread performs a syscall where which the call-stack is recreated.
Unfortunately, with compiler optimizations such as frame pointer omission (FPO), stack unwinding becomes difficult [^1], forcing the profiler to rely on heuristics.
This in turn causes a 2~3% performance slowdown which we was trying to avoid using FPO in the first place.

This project is trying to avoid this problem altogether by using the shadow stack ISA extensions.
Specifically in RISC-V, the zicfiss extensions enable applications to create shadow stacks.
Although these instructions were designed as a security feature to protect application against ROP attacks, we can try using this to alleviate the profiling overhead mentioned above.
The idea is simple: instead of disabling FPO or relying on heuristics, we can simply maintain a shadow stack during the application execution and when it becomes time to sample the call-stack, we simply perform a memcopy.
Of course, this approach is not perfect as we must execute an extra instruction to update the shadow stack after every function call.
Furthermore, maintaining the shadow stack in memory causes cache contention as well.
The exact performance tradeoff of using shadow stack vs maintaining frame pointers is difficult to speculate, but we assume that writing 8 bytes (single frame pointer) at every stack frame shouldn't cause a huge perturbation.

## Step-by-Step Implementation Plan

### 1. Understand the zicfiss extension execution semantics

- Reading this link should give you a good idea: [shadow stack to protect function returns on RISC-V linux](https://docs.kernel.org/next/arch/riscv/zicfiss.html)

### 2. Running this on Spike to see if we can get the shadow stack working

- Spike already has the zicfiss extension implemented
- Compile kernel with [CONFIG_RISCV_USER_CFI](https://lwn.net/Articles/1029648/) flags
    - Would need to hack firemarshal to add this flag during kernel compilation
    - Kernel needs to be able to allocate pages for the shadow stack
- Using `prctl` and `PR_SET_SHADOW_STACK_STATUS`, indicate to the kernel to turn on the shadow stack collection for this binary
    - The below code is GPT generated, but gives you an idea of how to use the `prctl` API

```c
// scs_demo.c
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>

#ifndef PR_SET_SHADOW_STACK_STATUS
#define PR_SET_SHADOW_STACK_STATUS 75
#define PR_GET_SHADOW_STACK_STATUS 76
#define PR_LOCK_SHADOW_STACK_STATUS 77
#define PR_SHADOW_STACK_ENABLE     (1u<<0)
#endif

static void on_sigsegv(int sig, siginfo_t*si, void*ctx) {
  printf("Got SIGSEGV si_code=%d (expect SEGV_CPERR for sspopchk mismatch)\n", si->si_code);
  _Exit(0);
}

int main(){
  struct sigaction sa = {.sa_sigaction=on_sigsegv,.sa_flags=SA_SIGINFO};
  sigaction(SIGSEGV,&sa,NULL);

  // Ask kernel to allocate & enable user shadow stack:
  long r = prctl(PR_SET_SHADOW_STACK_STATUS, PR_SHADOW_STACK_ENABLE, 0,0,0);
  if (r != 0) { perror("prctl enable shadow stack"); return 1; }


  printf("PUT YOUR APPLICATION HERE!!! NEED TO PERFORM SOME STACK CALLS, PERHAPS START WITH RECURSIVE FIBO\n");
  return 0;
}
```

- Add compiler flags to add zicfiss instructions to the compiled binary: [GNU GCC RISC-V Options](https://gcc.gnu.org/onlinedocs/gcc/RISC-V-Options.html)

### 3. Intercept the `perf` stack unwinding function & update it to use the shadow stack

- Get `perf` working within Spike for a simple application
    - There are alternative profilers with a fresh codebase such as [samply](https://github.com/mstange/samply), but would have to get Rust running on Spike which could be annoying (but definitely doable)
- Instrument `perf` and the kernel to understand how it collects stack samples under the hood
- Modify the `perf` stack unwinding routine to perform a memcopy from the shadow stack page when this is enabled for the application under interest
    - Reading from the shadow stack does not violate the page access permissions and hence should not cause any page faults

### 4. Implement the zicfiss extension in Rocket (and BOOM if you have time)

- Implement some RTL in RocketChip
    - For Rocket, I assume the overhead of this approach could be quite high, but much less so for a superscaler OoO core
- End to end testing can happen in FireSim

## Future Work

Unfortunately, this trick won't work for runtime managed languages such as Java.
Although the Java Flight Recorder (JFR) has improved significantly[^2][^3], a hardware assisted profiling framework has the potential to reduce perturbation.
Finding a general solution towards reducing perturbation for application profiling with hardware support is something that is worth looking into.

---

[^1]: [Lessons from frame pointers](https://community.ibm.com/community/user/blogs/kevin-grigorenko1/2023/02/21/lessons-from-the-field-26-frame-pointers-and-why-t)
[^2]: [Java 25's new CPU-Time Profiler](https://mostlynerdless.de/blog/2025/06/11/java-25s-new-cpu-time-profiler-1/)
[^3]: [Taming the bias](https://mostlynerdless.de/blog/2025/05/20/taming-the-bias-unbiased-safepoint-based-stack-walking-in-jfr/)
