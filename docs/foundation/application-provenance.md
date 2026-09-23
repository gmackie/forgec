# Application provenance and integration boundary

Read-only inspection on 2026-09-22 found all six named application repositories. No `@forgegraph/foundation` source imports were found (lockfiles excluded). The package consumers are synthetic schema probes; this evidence does not claim production adoption, deployed migrations or completed application dogfooding.

| Application revision | Inspected source and operation | Foundation probe mapping |
| --- | --- | --- |
| KanBanger `a7fd7b265201dcbf72bf3ae781c3506d13164384` | `packages/db/src/schema.ts`: issues1210, comments1394, notifications1875; `packages/api/src/services/comment-service.ts:66` createComment | Collaboration KanBangerIssue and Notifications KanBangerNotice |
| Bob `7863b955bba50fb63d276e7ba5f3fea054774619` | Nested bob/bob checkout; `packages/bob/src/schema/src/work-items.ts:507` workItems and870 workItemArtifacts; `packages/bob/src/api/src/rpc-layers/work-items.ts`: promoteToTask29, comment31, artifact34, notification45 | DevelopmentRequest, BobDevelopmentRun, BobUpdate; no exact BobRunner correspondence established |
| ForgeGraph `29ac91eb8c8fe76f9e8a071f11ab70c8e10ddc85` | `packages/db/src/schema/deployment.ts:35`, attestation.ts19, execution-request.ts38, pipeline-event.ts27; `packages/api/src/lib/deployment-rollback.ts:27` createRollbackDeployment | Deployment, Change, Evidence consumers |
| LevelForge `2f9eac2046649d1bdc862a3793b1a783c4591c5c` | `packages/db/src/schema.ts`: generations320, modelAssets878, episodeEvaluations3051, generativeAssets3560; `packages/api/src/services/content-evaluation-adapter.ts` | LevelGeneration and candidate/evaluation probes; experimental assignment correspondence unverified |
| Stream Conductor `f204934248427ddc742e45caba92c8bbfc209ca5` | `packages/db/src/schema/production.ts`: productionSessions7, productionCommands32; organizations.ts58 broadcasts; `apps/web/src/server/routers/production.ts`: getState129, command137 | BroadcastSession and MediaProduction |
| LatchFlow `314a3ea4a326606b2b9587c3c3da2ad60c87d325` | `packages/db/src/tenant-schema.ts`: rooms11, flows37, devices91, roomRuns192, bookings350; `packages/api/src/routers/runtime.ts:859` startRun | ExperienceSession synthetic probe; actual application domain uses Run |

The Foundation consumer sources exercise software, manufacturing, laboratory/science, healthcare, media/entertainment and finance/inventory. Examples include Deployment, ManufacturingBatch, LabExperiment, HospitalBed, BroadcastSession, ExperienceSession, Money, Inventory and ComputeCredits. These establish cross-domain type usability. Real application integration requires a separate adapter/migration and end-to-end test in each application, preserving its existing vocabulary and authorization model.

The epic’s named domain set is represented by HealthcarePreauthorization/HospitalBed (healthcare), ManufacturingRun/ManufacturingBatch (manufacturing), Classroom/ClassroomBooking (education), ProcurementBid/ProcurementQuote (commerce), and Party PrincipalRepresentation plus Participation/Entitlement policy probes (IAM). These remain synthetic generated-bundle tests.

## Opt-in application adapters, 2026-09-23

The initial inspection above is retained as historical evidence. There are now six
opt-in adapters under `examples/foundation/apps`, with source revisions and file
digests pinned in each `verification.json`. Four applications have separate local
application changes, supplied as `app-source.patch`; ForgeGraph and LevelForge use
existing injection/function seams without changing their application repositories.
These are bounded local integrations, not enabled production adoption.

| Application and pinned revision | Actual application seam | Foundation behavior and verification boundary |
| --- | --- | --- |
| KanBanger `4e7b4ceae0af089f8bb51c5f1b31dcfcf728b2f3` | `foundation-intake-service.ts`, exported alongside the shared issue service | Reconciles an existing issue into Intake Submission and typed IssueSubmission, retaining creator/team identity. Trace invokes the actual service with controlled application DB reads and real Foundation storage; it does not execute the normal createIssue request path or write the application DB. |
| Bob `e29db569155dfe3924ec84adf080bd40c373731e` | `foundationFulfillmentService.ts`, exported from planningWriteService | Reconciles a persisted completed taskRun into FulfillmentEnd and RunCompletion. Requires an independently recorded start; never treats row creation as execution start. Trace controls the application DB read and executes the actual service and Foundation writes; it does not run a Bob agent. |
| ForgeGraph `29ac91eb8c8fe76f9e8a071f11ab70c8e10ddc85` | Actual `summarizeChecks` event fold and `isEligibleForAutoMerge` policy function | Executes a newly bound Evaluation of historical CI observations with exact head/event/policy pins. Trace invokes the real functions; it does not run CI, merge, deploy, or replace merge authorization/head CAS. |
| LevelForge `2f9eac2046649d1bdc862a3793b1a783c4591c5c` | Existing ArtifactProductionJobStore injection into actual recipe runtime, graph compiler, registry and filesystem store | Records typed job attempts and Evaluation execution through a store decorator. Trace runs real recipe execution with controlled executors, failure/resume and mirror recovery. It does not certify external generation providers, assets or publication. |
| Stream Conductor `6783448b79460ad15050b588c92a3cbff31c59bf` | Opt-in production router port and actual `projectAcknowledgedProduction` service | Projects a persisted acknowledged production command into typed Fulfillment. Foundation trace executes the projection service; separate native router tests cover the acknowledgment boundary. It does not operate OBS or certify an entire broadcast. |
| LatchFlow `0771f0118e41cba80e7c4d3330b7cf151733d82a` | Opt-in startRun port and actual `projectStartedRun` service | Projects a native Run and exact compiled flow into Operations/Lineage: idle remains Planned, running becomes Running. Foundation trace executes the projection service; separate native router tests cover authorization before native writes. It does not start a physical runner or claim successful business completion. |

`pnpm foundation:apps` requires the named source roots, verifies pinned files
against both their working copies and immutable revisions, builds deterministic
artifacts, and records actual passing trace names. KanBanger and Bob descriptors
require memory, SQLite and PostgreSQL; the other four require memory and SQLite
and additionally run PostgreSQL when configured. A passing receipt without those
PostgreSQL assertion names does not establish PostgreSQL coverage. Final receipts
must be collected after source freeze; this table is not a claim that the final
integrated source has passed all six suites.

The app DB and Foundation DB are separate commit domains. These adapters expose
explicit replay or pending-projection recovery, not an automatic durable outbox.
App-local tests, typecheck limitations and opt-in call sites are described in each
adapter README. The six Foundation traces do not replace full application builds,
authenticated request-to-provider end-to-end tests, deployment-specific migrations
or application rollout. Keep those boundaries explicit when updating #25 and #71.
