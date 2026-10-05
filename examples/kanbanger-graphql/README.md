# Issue-tracker GraphQL compatibility fixture

This small KanBanger/Linear-style model demonstrates projecting legacy operation,
object, and field names over canonical Forge operations. It is not a complete
implementation of Linear's API (including its nested state and connection types).

Regenerate the checked-in test bundle from the repository root:

```sh
forgec build examples/kanbanger-graphql --out examples/kanbanger-graphql/generated
cp examples/kanbanger-graphql/generated/app.json packages/interfaces/test/fixtures/kanbanger.app.json
```

The executable compatibility mapping and create/list/complete scenario are in
`packages/interfaces/test/graphql.test.ts`. Pagination uses Forge's `items`,
`next`, and `limit` envelope. No independent GraphQL storage model is introduced.
