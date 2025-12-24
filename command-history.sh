npx vitest run src/ripgrep/__tests__/index.spec.ts
npx vitest run src/__tests__/core-library.test.ts
npx vitest run src/__tests__/nodejs-adapters.test.ts
npx ts-node --transpile-only src/examples/run-example.ts basic
npx tsc --noEmit src/examples/nodejs-usage.ts
tsc --noEmit -p tsconfig.lib.json
npx tsx src/examples/run-demo-tui.tsx
npx tsc src/examples/run-demo.ts --outDir dist
npx tsx src/examples/run-demo.ts

npx @modelcontextprotocol/inspector --cli npx tsx src/cli.ts --stdio-adapter --method tools/call --tool-name search_codebase --tool-arg query=greet
npx @modelcontextprotocol/inspector --cli http://localhost:3001/mcp --method tools/call --tool-name search_codebase --tool-arg query=greet
git push origin --tags
git tag 0.0.6
git tag -d 0.0.1
npm pack
npm adduser --registry https://registry.npmjs.org/
npm publish --access public --registry https://registry.npmjs.org/
