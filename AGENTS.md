# AGENTS.md instructions for Azure DevOps MCP Server

## Development Commands

**Build & Run:**

- `npm run build` - Compile TypeScript to `dist/`
- `npm run dev` - Development with auto-restart (ts-node-dev)
- `npm start` - Run compiled server from `dist/index.js`
- `npm run inspector` - Debug with MCP Inspector

**Testing (3-tier strategy):**

- `npm run test:unit` - Unit tests (mock all external dependencies, no credentials needed)
- `npm run test:int` - Integration tests (require valid Azure DevOps credentials in `.env`)
- `npm run test:e2e` - End-to-end tests (require credentials, test full MCP flow)
- `npm test` - Run all test suites in order: unit → integration → e2e

**Code Quality:**

- `npm run lint` - ESLint check
- `npm run lint:fix` - Auto-fix lint issues
- `npm run format` - Prettier formatting
- **Always run `lint:fix && format && build` before commits**

**Commit Workflow:**

- Use `npm run commit` for conventional commit messages (required)
- Commitlint/husky enforce conventional commits
- Never skip pre-commit hooks

## Architecture Notes

**Feature-based structure:**

- Each Azure DevOps feature lives in `src/features/[feature-name]/`
- Feature modules export: tools, request handlers, schemas
- Add new features by creating new module directories
- Server auto-registers features from imports in `src/server.ts`

**Path aliases:**

- Use `@/` for imports (e.g., `import { x } from '@/shared/utils'`)
- Configured in `tsconfig.json` paths

**Authentication:**

- Three methods: PAT, Azure Identity (default), Azure CLI
- Azure DevOps Server (on-prem) supports PAT only
- Environment variables: `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_AUTH_METHOD`, `AZURE_DEVOPS_PAT`
- Copy `.env.example` to `.env` and configure credentials

## Testing Constraints

**Unit tests (.spec.unit.ts):**

- Must pass without Azure DevOps credentials
- Mock all external dependencies
- Located alongside feature code

**Integration tests (.spec.int.ts):**

- Require valid `.env` configuration
- Test real Azure DevOps API calls
- Skip gracefully if credentials missing

**E2E tests (.spec.e2e.ts):**

- Test complete MCP server functionality
- Require credentials, longer timeout (30s)

## Important Knowledge References

<important-knowledge>
  <read-this-entire-file>docs/important-knowledge/azure-devops-rest-api-research.md</read-this-entire-file>
  <when>Researching Azure DevOps REST APIs, selecting api-version, or handling Azure DevOps Server (on-prem) endpoints.</when>
</important-knowledge>

<important-knowledge>
  <read-this-entire-file>docs/important-knowledge/llm-tldr-cli.md</read-this-entire-file>
  <when>Using llm-tldr CLI for repo analysis or investigating URL-based server selection.</when>
</important-knowledge>

## Gotchas

1. **Never commit `.env`** - Contains secrets
2. **Integration/E2E tests fail without credentials** - This is expected
3. **Use `npm run commit`** - Don't write commit messages manually
4. **Azure DevOps Server ≠ Azure DevOps Services** - Different API versions and auth support
5. **Test order matters** - Run unit → integration → e2e
6. **Path aliases required** - Use `@/` not relative imports for shared code
