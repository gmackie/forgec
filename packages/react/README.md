# @forgegraph/react

React bindings for a ForgeGraph app bundle: typed hooks over the generated client, with the
pagination, optimistic-concurrency and error semantics the runtime already enforces.

**Stability: stable-candidate.**

```bash
npm install @forgegraph/react
```

```tsx
import { createWorkspace } from "@forgegraph/react";
import { createClient } from "./generated/client.ts";

const { useRecord, useList, useMutation } = createWorkspace(createClient({ baseUrl, tenant, actor }));

function Customer({ id }: { id: string }) {
  const { data, error } = useRecord("customers", id);
  if (error) return <Problem error={error} />;
  return <h1>{data?.name}</h1>;
}
```

Every hook surfaces the runtime's Problem Details unchanged — `VersionConflict` carries the current
version for an `If-Match` retry, `NotPermitted` never discloses whether a record exists.

Apache-2.0
