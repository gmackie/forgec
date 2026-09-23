# Game boundary decision: B authority/replay, C numerical semantics

| Concern | Classification | Reason |
| --- | --- | --- |
| WorldState ownership, accepted input identity and TickCommitted history | L0 / A | Durable authority is distinct from predicted/projected client state. |
| Fixed tick progression and deterministic replay envelope | L0-facet / B | Changing tick duration or replay-equivalence rules changes game meaning; timer APIs do not. |
| ECS layout, prediction buffer and worker scheduling | L1 / A | Replaceable mechanisms under the same tick/admission/authority contract. |
| Session shard/server region and replica allocation | L2 / B | Placement affects latency and availability but must preserve a single logical AdvanceWorld owner. |
| Collision integration and platform-specific numerical determinism | external / C | A physics engine's solver, precision and scheduling laws are not implied by typed Process composition. |

Unity Netcode for Entities explicitly distinguishes server authority from client prediction, rollback and resimulation. ProjectClients is a projection boundary, not another WorldState producer. The official prediction documentation is comparison evidence; this fixture neither embeds Unity nor certifies its physics or prediction behavior.

Ptolemy II distinguishes synchronous/reactive, synchronous-dataflow and discrete-event directors. A TickDriver external event here means a request carrying an integer logical tick; it is not a hard real-time clock, a synchronous-dataflow token-rate contract, or super-dense simulation time. There is no need for a new Tick node kind. The replay facet must bind accepted input order, rules/solver builds, checkpoint bytes, random state and prohibited nondeterministic sources before bitwise replay is even a meaningful claim.

Logical simulation order is L0/facet meaning; the host thread pool, frame presentation cadence and CPU/GPU placement are L1/L2. AUTOSAR/Capella-style separation is useful even outside vehicles: changing server hardware must not silently change the intended rule contract. If a platform restriction is needed for deterministic floating point, express it as an explicit realization obligation rather than claiming universal deterministic execution.

Promotion argument: scientific experiments also require a reproducibility envelope, but their tolerance-based result equivalence differs from this game's exact tick digest. A shared replay/provenance facet should parameterize equivalence, not force either domain to adopt the other's numerical law. Keep the numerical engine external and refuse a replay guarantee until the actual harness passes.
