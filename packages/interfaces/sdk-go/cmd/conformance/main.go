// PAR-123 cross-language wire conformance runner (Go).
//
// Usage: conformance <base-url> <tenant>
// Prints one canonical JSON array of step outcomes (encoding/json sorts map keys).
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"forge.dev/interfaces/sdk-go/forge"
)

type step struct {
	name string
	op   string
	in   map[string]any
}

func main() {
	base, tenant := os.Args[1], os.Args[2]
	c := forge.New(base, forge.Credential{Tenant: tenant, Actor: "sdk-go"})
	steps := []step{
		{"create", "Customer.create", map[string]any{"code": "SDK", "name": "Sdk", "tier": "gold"}},
		{"get", "Customer.get", map[string]any{"id": "$create.id"}},
		{"enum", "Customer.create", map[string]any{"code": "SDK2", "name": "X", "tier": "platinum"}},
		{"patch-null", "Customer.update", map[string]any{"id": "$create.id", "expectedVersion": 1, "patch": map[string]any{"email": nil}}},
		{"patch-absent", "Customer.update", map[string]any{"id": "$create.id", "expectedVersion": 2, "patch": map[string]any{"tier": "standard"}}},
		{"stale", "Customer.update", map[string]any{"id": "$create.id", "expectedVersion": 1, "patch": map[string]any{"name": "Stale"}}},
		{"site", "Site.create", map[string]any{"customer": "$create.id", "code": "S1", "name": "Site 1", "timezone": "UTC"}},
		{"order", "Order.create", map[string]any{"customer": "$create.id", "site": "$site.id", "subtotal": "10.10", "tax": "0.20", "requestedOn": "2026-09-20"}},
		{"transition", "Order.status.approve", map[string]any{"id": "$order.id", "expectedVersion": 1, "input": map[string]any{}}},
		{"job", "ProcessOrder.start", map[string]any{"order": "$order.id", "expectedVersion": 1}},
		{"page", "Customer.list.byTier", map[string]any{"params": map[string]any{"tier": "standard"}, "limit": 5}},
		{"missing", "Customer.get", map[string]any{"id": "nope"}},
	}
	if len(os.Args) > 3 {
		data, err := os.ReadFile(os.Args[3])
		if err != nil {
			panic(err)
		}
		var fixture []struct {
			Step      string         `json:"step"`
			Operation string         `json:"operation"`
			Input     map[string]any `json:"input"`
		}
		decoder := json.NewDecoder(strings.NewReader(string(data)))
		decoder.UseNumber()
		if err := decoder.Decode(&fixture); err != nil {
			panic(err)
		}
		steps = nil
		for _, s := range fixture {
			steps = append(steps, step{s.Step, s.Operation, s.Input})
		}
	}
	var out []map[string]any
	seen := map[string]map[string]any{}
	// "$step.field" placeholders chain ids from earlier steps
	var bind func(v any) any
	bind = func(v any) any {
		switch x := v.(type) {
		case string:
			if strings.HasPrefix(x, "$") {
				parts := strings.SplitN(x[1:], ".", 2)
				return seen[parts[0]][parts[1]]
			}
		case []any:
			out := make([]any, len(x))
			for i, y := range x {
				out[i] = bind(y)
			}
			return out
		case map[string]any:
			out := map[string]any{}
			for k, y := range x {
				out[k] = bind(y)
			}
			return out
		}
		return v
	}
	for _, s := range steps {
		v, err := c.Call(s.op, bind(s.in).(map[string]any))
		if err == nil {
			if m, ok := v.(map[string]any); ok {
				seen[s.name] = m
			}
			if s.name == "job" {
				m := v.(map[string]any)
				v = map[string]any{"workflow": m["workflow"], "status": m["status"], "version": m["version"]}
			}
			if s.name == "order" {
				if total, _ := v.(map[string]any)["total"].(string); total != "10.30" {
					fmt.Fprintf(os.Stderr, "money total is not exact: %v\n", v.(map[string]any)["total"])
					os.Exit(1)
				}
			}
			out = append(out, map[string]any{"step": s.name, "kind": "ok", "value": v})
			continue
		}
		var p *forge.ProblemError
		var inv *forge.InvocationFailed
		switch {
		case errors.As(err, &p):
			paths := []string{}
			for _, f := range p.Fields {
				paths = append(paths, f.Path)
			}
			sort.Strings(paths)
			out = append(out, map[string]any{"step": s.name, "kind": "error", "problem": map[string]any{"code": p.Code, "status": p.Status, "fields": paths}})
		case errors.As(err, &inv):
			out = append(out, map[string]any{"step": s.name, "kind": "invocationFailed", "reason": inv.Reason})
		default:
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
