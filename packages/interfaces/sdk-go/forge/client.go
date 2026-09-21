// Package forge is the generic Forge API client (FORGE-055, PAR-123).
//
// Operations are discovered from the deployment's own OpenAPI projection and
// invoked through the same unary envelope the TypeScript and Python clients
// use. Money and decimal fields stay strings; integers decode as json.Number,
// so no value is rounded by the client. A Problem the contract declares is a
// *ProblemError; a failure to perform the call at all is an *InvocationFailed.
package forge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// Credential authenticates every request.
type Credential struct {
	Token  string // bearer token
	Tenant string // development header pair (against a dev host only)
	Actor  string
}

// Expect pins the contract the client was generated against; a mismatch fails before the first call.
type Expect struct {
	Contracts string
	Wire      string
}

// ProblemError is a business outcome (Problem Details).
type ProblemError struct {
	Code      string          `json:"code"`
	Status    int             `json:"status"`
	Title     string          `json:"title,omitempty"`
	Detail    string          `json:"detail,omitempty"`
	Retryable bool            `json:"retryable,omitempty"`
	Fields    []ProblemField  `json:"fields,omitempty"`
	Raw       json.RawMessage `json:"-"`
}

type ProblemField struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (p *ProblemError) Error() string { return p.Code + ": " + p.Detail }

// InvocationFailed is the binding failing to perform the call at all.
type InvocationFailed struct {
	Reason    string // transport | malformed | contract-mismatch | unauthenticated
	Detail    string
	Retryable bool
}

func (e *InvocationFailed) Error() string { return e.Reason + ": " + e.Detail }

type route struct {
	method     string
	path       string
	kind       string
	pathParams []string
}

// Client talks to one deployment.
type Client struct {
	Base       string
	Credential Credential
	Purpose    string
	Expect     Expect
	HTTP       *http.Client
	routes     map[string]route
	Discovery  map[string]any
}

func New(base string, cred Credential) *Client {
	return &Client{Base: strings.TrimRight(base, "/"), Credential: cred, HTTP: http.DefaultClient}
}

func (c *Client) headers(h http.Header) {
	if c.Credential.Token != "" {
		h.Set("Authorization", "Bearer "+c.Credential.Token)
	} else {
		h.Set("X-Forge-Tenant", c.Credential.Tenant)
		h.Set("X-Forge-Actor", c.Credential.Actor)
	}
	h.Set("Accept", "application/json")
}

func (c *Client) do(method, path string, body any, extra map[string]string) (int, http.Header, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, nil, &InvocationFailed{Reason: "malformed", Detail: err.Error()}
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.Base+path, rd)
	if err != nil {
		return 0, nil, nil, &InvocationFailed{Reason: "malformed", Detail: err.Error()}
	}
	c.headers(req.Header)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, nil, &InvocationFailed{Reason: "transport", Detail: err.Error(), Retryable: true}
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, data, nil
}

func (c *Client) load() (map[string]route, error) {
	if c.routes != nil {
		return c.routes, nil
	}
	status, _, data, err := c.do("GET", "/forge/discovery", nil, nil)
	if err != nil {
		return nil, err
	}
	if status == 401 || status == 403 {
		return nil, &InvocationFailed{Reason: "unauthenticated", Detail: "the credential is not accepted by this deployment"}
	}
	if status != 200 {
		return nil, &InvocationFailed{Reason: "malformed", Detail: fmt.Sprintf("discovery answered %d", status), Retryable: status >= 500}
	}
	var disc map[string]any
	if err := json.Unmarshal(data, &disc); err != nil {
		return nil, &InvocationFailed{Reason: "malformed", Detail: err.Error()}
	}
	c.Discovery = disc
	var mismatch []string
	if c.Expect.Contracts != "" {
		if m, _ := disc["contracts"].(map[string]any); m == nil || m["version"] != c.Expect.Contracts {
			mismatch = append(mismatch, "contracts")
		}
	}
	if c.Expect.Wire != "" {
		if m, _ := disc["digests"].(map[string]any); m == nil || m["wire"] != c.Expect.Wire {
			mismatch = append(mismatch, "wire digest")
		}
	}
	if len(mismatch) > 0 {
		// A compatibility question for `forgec compat`, never assumed equivalence.
		return nil, &InvocationFailed{Reason: "contract-mismatch", Detail: strings.Join(mismatch, ", ") + " differ from the expectation"}
	}
	status, _, data, err = c.do("GET", "/forge/openapi.json", nil, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, &InvocationFailed{Reason: "malformed", Detail: fmt.Sprintf("openapi answered %d", status)}
	}
	var doc struct {
		Paths map[string]map[string]struct {
			OperationID string `json:"operationId"`
			Kind        string `json:"x-forge-kind"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, &InvocationFailed{Reason: "malformed", Detail: err.Error()}
	}
	routes := map[string]route{}
	for path, ops := range doc.Paths {
		var params []string
		for _, seg := range strings.Split(path, "/") {
			if strings.HasPrefix(seg, "{") {
				params = append(params, strings.Trim(seg, "{}"))
			}
		}
		for method, op := range ops {
			kind := op.Kind
			if kind == "" {
				kind = "function"
			}
			routes[op.OperationID] = route{method: strings.ToUpper(method), path: path, kind: kind, pathParams: params}
		}
	}
	c.routes = routes
	return routes, nil
}

// Operations lists the deployment's operation ids.
func (c *Client) Operations() ([]string, error) {
	r, err := c.load()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r))
	for k := range r {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

func (c *Client) resolve(op string) (string, route, error) {
	routes, err := c.load()
	if err != nil {
		return "", route{}, err
	}
	if r, ok := routes[op]; ok {
		return op, r, nil
	}
	for id, r := range routes {
		if i := strings.LastIndex(id, "/_/"); i >= 0 && id[i+3:] == op {
			return id, r, nil
		}
	}
	return "", route{}, &ProblemError{Code: "MethodNotAllowed", Status: 405, Detail: "unknown operation " + op}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// request mirrors the TypeScript toHttpRequest: envelope -> path, body, headers.
func request(r route, in map[string]any) (string, any, map[string]string) {
	headers := map[string]string{}
	path := r.path
	query := url.Values{}
	var body any
	fill := func() {
		for _, p := range r.pathParams {
			path = strings.Replace(path, "{"+p+"}", url.PathEscape(fmt.Sprint(in[p])), 1)
		}
	}
	ifMatch := func() {
		if v, ok := in["expectedVersion"]; ok && v != nil {
			headers["If-Match"] = fmt.Sprintf("\"%v\"", v)
		}
	}
	without := func(keys ...string) map[string]any {
		out := map[string]any{}
		for k, v := range in {
			if !contains(keys, k) && !contains(r.pathParams, k) {
				out[k] = v
			}
		}
		return out
	}
	switch r.kind {
	case "create", "changeset.propose", "workflow.start", "schedule.tick":
		body = in
		fill()
	case "update":
		fill()
		ifMatch()
		body = in["patch"]
		if body == nil {
			body = map[string]any{}
		}
	case "transition":
		fill()
		ifMatch()
		body = in["input"]
		if body == nil {
			body = map[string]any{}
		}
	case "delete", "restore", "finalizeUpload":
		fill()
		ifMatch()
	case "move", "beginUpload":
		fill()
		ifMatch()
		body = without("id", "expectedVersion")
	case "find", "list", "view.query", "effective":
		if params, ok := in["params"].(map[string]any); ok {
			for k, v := range params {
				query.Set(k, fmt.Sprint(v))
			}
		}
		if v, ok := in["cursor"]; ok && v != nil {
			query.Set("cursor", fmt.Sprint(v))
		}
		if v, ok := in["limit"]; ok && v != nil {
			query.Set("limit", fmt.Sprint(v))
		}
	case "cache.read":
		if key, ok := in["key"].(map[string]any); ok {
			for k, v := range key {
				query.Set(k, fmt.Sprint(v))
			}
		}
	case "function":
		fill()
		ifMatch()
		body = without()
	default:
		fill()
		if r.method != "GET" {
			body = without("id")
		}
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	return path, body, headers
}

// Call invokes one operation with the unary envelope. The result is decoded with json.Number.
func (c *Client) Call(op string, in map[string]any, opts ...func(map[string]string)) (any, error) {
	id, r, err := c.resolve(op)
	if err != nil {
		return nil, err
	}
	_ = id
	if in == nil {
		in = map[string]any{}
	}
	path, body, headers := request(r, in)
	if c.Purpose != "" {
		headers["X-Forge-Purpose"] = c.Purpose
	}
	for _, o := range opts {
		o(headers)
	}
	status, _, data, err := c.do(r.method, path, body, headers)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var payload any
	if len(data) > 0 {
		if err := dec.Decode(&payload); err != nil {
			return nil, &InvocationFailed{Reason: "malformed", Detail: fmt.Sprintf("non-JSON reply (%d)", status), Retryable: status >= 500}
		}
	}
	if status >= 200 && status < 300 {
		return payload, nil
	}
	if status == 401 {
		return nil, &InvocationFailed{Reason: "unauthenticated", Detail: "the credential is not accepted by this deployment"}
	}
	var p ProblemError
	if err := json.Unmarshal(data, &p); err == nil && p.Code != "" {
		p.Raw = data
		return nil, &p
	}
	return nil, &InvocationFailed{Reason: "malformed", Detail: fmt.Sprintf("reply %d is not a Problem", status), Retryable: status >= 500}
}

// WithPurpose selects the purpose surface for one call.
func WithPurpose(p string) func(map[string]string) {
	return func(h map[string]string) { h["X-Forge-Purpose"] = p }
}

// WithIdempotencyKey makes a mutation replay-safe.
func WithIdempotencyKey(k string) func(map[string]string) {
	return func(h map[string]string) { h["Idempotency-Key"] = k }
}

// IsProblem reports whether err is a business outcome with the given code.
func IsProblem(err error, code string) bool {
	var p *ProblemError
	return errors.As(err, &p) && p.Code == code
}
