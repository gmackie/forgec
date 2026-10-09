/**
 * Third-party APIs the playground can call without a ForgeGraph contract.
 *
 * Each entry pins a small OpenAPI document (a curated subset, not the vendor's
 * multi-megabyte spec) and the sha256 of those exact bytes. Loading recomputes
 * the digest and refuses the preset on a mismatch. `specUrl` is the upstream
 * spec home. A preset with no bundled `document` is fetched from `specUrl` instead.
 */
export interface IntegrationPreset {
  id: string;
  name: string;
  description: string;
  specUrl: string;
  /** Lowercase hex SHA-256 of `document`. */
  sha256: string;
  document: string;
  baseUrl: string;
  auth: { kind: "bearer"; secret: string };
}

const githubDocument = `openapi: "3.1.0"
info:
  title: GitHub
  version: "2022-11-28"
paths:
  /user:
    get:
      operationId: github.user.get
      summary: Get the authenticated user
      tags: [Users]
      responses:
        "200":
          description: Success
  /repos/{owner}/{repo}:
    get:
      operationId: github.repos.get
      summary: Get a repository
      tags: [Repos]
      parameters:
        - name: owner
          in: path
          required: true
          schema:
            type: string
        - name: repo
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Success
  /repos/{owner}/{repo}/issues:
    get:
      operationId: github.issues.list
      summary: List repository issues
      tags: [Issues]
      parameters:
        - name: owner
          in: path
          required: true
          schema:
            type: string
        - name: repo
          in: path
          required: true
          schema:
            type: string
        - name: state
          in: query
          schema:
            type: string
            enum: [open, closed, all]
        - name: per_page
          in: query
          schema:
            type: integer
      responses:
        "200":
          description: Success
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
security:
  - bearer: []
`;

const cloudflareDocument = `openapi: "3.1.0"
info:
  title: Cloudflare
  version: "4"
paths:
  /client/v4/user:
    get:
      operationId: cloudflare.user.get
      summary: Get the current user
      tags: [User]
      responses:
        "200":
          description: Success
  /client/v4/zones:
    get:
      operationId: cloudflare.zones.list
      summary: List zones
      tags: [Zones]
      parameters:
        - name: name
          in: query
          schema:
            type: string
        - name: page
          in: query
          schema:
            type: integer
      responses:
        "200":
          description: Success
  /client/v4/zones/{zone_id}:
    get:
      operationId: cloudflare.zones.get
      summary: Get a zone
      tags: [Zones]
      parameters:
        - name: zone_id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Success
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
security:
  - bearer: []
`;

const stripeDocument = `openapi: "3.1.0"
info:
  title: Stripe
  version: "2024-06-20"
paths:
  /v1/balance:
    get:
      operationId: stripe.balance.get
      summary: Retrieve balance
      tags: [Balance]
      responses:
        "200":
          description: Success
  /v1/customers:
    get:
      operationId: stripe.customers.list
      summary: List customers
      tags: [Customers]
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
      responses:
        "200":
          description: Success
  /v1/customers/{customer}:
    get:
      operationId: stripe.customers.get
      summary: Retrieve a customer
      tags: [Customers]
      parameters:
        - name: customer
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Success
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
security:
  - bearer: []
`;

const linearDocument = `openapi: "3.1.0"
info:
  title: Linear
  version: "graphql"
paths:
  /graphql:
    post:
      operationId: linear.graphql
      summary: Run a GraphQL query
      tags: [GraphQL]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [query]
              properties:
                query:
                  type: string
                variables:
                  type: object
      responses:
        "200":
          description: Success
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
security:
  - bearer: []
`;

export const builtinPresets: readonly IntegrationPreset[] = [
  {
    id: "github",
    name: "GitHub",
    description: "GitHub REST API. Set INTEGRATION_GITHUB to a token with the access you want to call.",
    specUrl: "https://github.com/github/rest-api-description",
    sha256: "175496c5cc402b5e5b948e92dc6944b679fef87caa960197a8337db85103f712",
    document: githubDocument,
    baseUrl: "https://api.github.com",
    auth: { kind: "bearer", secret: "INTEGRATION_GITHUB" },
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Cloudflare API v4. Set INTEGRATION_CLOUDFLARE to an API token.",
    specUrl: "https://github.com/cloudflare/api-schemas",
    sha256: "07d66b8581afae5964ea897ba8c7851749e4537e0daf318b472b422500baa4ac",
    document: cloudflareDocument,
    baseUrl: "https://api.cloudflare.com",
    auth: { kind: "bearer", secret: "INTEGRATION_CLOUDFLARE" },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Stripe API. Set INTEGRATION_STRIPE to a secret key.",
    specUrl: "https://github.com/stripe/openapi",
    sha256: "e85877c37f36ea849d39bd7f86e89b43c978153f6b78afdbe98107dbd454cc03",
    document: stripeDocument,
    baseUrl: "https://api.stripe.com",
    auth: { kind: "bearer", secret: "INTEGRATION_STRIPE" },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Linear GraphQL. Set INTEGRATION_LINEAR to a personal API key. Queries are POST, so writes must be enabled and each call confirmed.",
    specUrl: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
    sha256: "9630ba33a864a4fbb063d2b69ca5583a0f5bd8e656120ace7df0281e55e2a39b",
    document: linearDocument,
    baseUrl: "https://api.linear.app",
    auth: { kind: "bearer", secret: "INTEGRATION_LINEAR" },
  },
];
