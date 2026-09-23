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
