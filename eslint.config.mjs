import { plugin as shadcn } from "@shadcn/lint"
import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import betterTailwind from "eslint-plugin-better-tailwindcss"
import functional from "eslint-plugin-functional"
import preferArrowFunctions from "eslint-plugin-prefer-arrow-functions"
import sonarjs from "eslint-plugin-sonarjs"
import unicorn from "eslint-plugin-unicorn"

const DIRECTIVE =
  /^\s*(eslint-disable|eslint-enable|@ts-expect-error|@ts-check|global |\/ <reference|[#@]__PURE__|webpack)/u

const VENDORED = ["src/components/ui/**", "src/components/ai-elements/**", "src/lib/utils.ts"]

const noComments = {
  meta: {
    type: "suggestion",
    schema: [{ type: "object", properties: { allowJsdocOnExports: { type: "boolean" } }, additionalProperties: false }],
    messages: {
      noComment: "Comments are not allowed. Encode the intent in a well-named function or variable instead.",
    },
  },
  create: (context) => {
    const { sourceCode } = context
    const allowJsdoc = context.options[0]?.allowJsdocOnExports ?? false
    const isExportJsdoc = (comment) => {
      const next = sourceCode.getTokenAfter(comment, { includeComments: false })
      return allowJsdoc && comment.type === "Block" && comment.value.startsWith("*") && next?.value === "export"
    }
    const isAllowed = (comment) => comment.type === "Shebang" || DIRECTIVE.test(comment.value) || isExportJsdoc(comment)
    const reportComment = (comment) => context.report({ loc: comment.loc, messageId: "noComment" })
    return {
      Program: () =>
        sourceCode
          .getAllComments()
          .filter((comment) => !isAllowed(comment))
          .forEach(reportComment),
    }
  },
}

const local = { meta: { name: "local" }, rules: { "no-comments": noComments } }

const arrowSyntax = [
  {
    selector: "ExportDefaultDeclaration > FunctionDeclaration",
    message: "Use an arrow function: declare `const Name = () => ...` and end the file with `export default Name`.",
  },
]

const builderSyntax = [
  { selector: "IfStatement[alternate]", message: "No else: use an early return (guard clause)." },
  {
    selector: "CallExpression:not([callee.name=/^use[A-Z]/]) > ArrowFunctionExpression[body.type='BlockStatement']",
    message: "Inline callbacks must be expressions; extract a named function.",
  },
  {
    selector: "JSXExpressionContainer > ArrowFunctionExpression[body.type='BlockStatement']",
    message: "Extract this handler into a named function.",
  },
]

const builderStyle = {
  complexity: ["error", { max: 3 }],
  "max-depth": ["error", 1],
  "max-nested-callbacks": ["error", 2],
  "max-params": ["error", 3],
  "max-statements": ["error", 8],
  "no-else-return": ["error", { allowElseIf: false }],
  "no-nested-ternary": "error",
  "no-lonely-if": "error",
  "no-param-reassign": ["error", { props: true }],
  "prefer-const": "error",
  "no-console": "error",
  "no-restricted-syntax": ["error", ...builderSyntax, ...arrowSyntax],
  "sonarjs/cognitive-complexity": ["error", 5],
  "sonarjs/expression-complexity": ["error", { max: 2 }],
  "sonarjs/no-nested-conditional": "error",
  "sonarjs/prefer-immediate-return": "error",
  "sonarjs/prefer-single-boolean-return": "error",
  "unicorn/consistent-function-scoping": "error",
  "unicorn/no-negated-condition": "error",
  "functional/no-let": "error",
  "functional/no-loop-statements": "error",
  "functional/no-classes": "error",
}

const arrowStyle = {
  "func-style": ["error", "expression"],
  "prefer-arrow-functions/prefer-arrow-functions": [
    "error",
    {
      allowNamedFunctions: false,
      allowObjectProperties: false,
      classPropertiesAllowed: false,
      returnStyle: "unchanged",
    },
  ],
  "arrow-body-style": ["error", "as-needed"],
  "prefer-rest-params": "error",
  "no-invalid-this": "error",
  "no-use-before-define": "off",
  "@typescript-eslint/no-use-before-define": [
    "error",
    { functions: false, classes: false, variables: false, allowNamedExports: false },
  ],
}

const TYPE_PREFIX = "(str|int|num|arr|obj|bool|bln|fn|func|lst|dict)[A-Z]"

const VAGUE_NAME =
  "(data|result|res|ret|item|obj|val|tmp|temp|foo|bar|info|stuff|thing|handle|handler|process|manager|helper|util|utils|cb|fn|func|arr|str|num|flag)$"

const NEXT_ROUTE_OPTIONS = "^(dynamic|dynamicParams|revalidate|fetchCache|runtime|preferredRegion|maxDuration)$"

const toUpperCasePattern = (pattern) => pattern.toUpperCase().replace("[A-Z]", "_")

const namingConvention = (bannedPatterns) => [
  "error",
  {
    selector: "variable",
    modifiers: ["const", "global"],
    types: ["boolean", "string", "number"],
    filter: { regex: NEXT_ROUTE_OPTIONS, match: false },
    format: ["UPPER_CASE"],
    custom: { regex: `^(${bannedPatterns.map(toUpperCasePattern).join("|")})`, match: false },
  },
  { selector: "variableLike", format: null, custom: { regex: `^(${bannedPatterns.join("|")})`, match: false } },
  {
    selector: ["interface", "typeAlias", "enum"],
    format: ["PascalCase"],
    custom: { regex: "^[ITE][A-Z][a-z]", match: false },
  },
]

const naming = {
  "id-length": ["error", { min: 3, max: 40, properties: "never", exceptions: ["id", "ok", "_"] }],
  "unicorn/prevent-abbreviations": [
    "error",
    { replacements: { props: false, params: false, ref: false, env: false, args: false } },
  ],
  "@typescript-eslint/naming-convention": namingConvention([TYPE_PREFIX, VAGUE_NAME]),
}

const shadcnComponent = (element, component, name) => ({
  element,
  message: `Use <${component}> from @/components/ui/${name} instead. Add it with \`pnpm dlx shadcn@latest add ${name}\` if it is missing.`,
})

const interfaceRules = {
  "shadcn/no-restyle": ["error", { allow: ["layout"] }],
  "shadcn/no-raw-colors": "error",
  "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
  "shadcn/no-inline-styles": "error",
  "shadcn/no-unknown-classes": "error",
  "shadcn/require-static-classes": "error",
  "better-tailwindcss/no-conflicting-classes": "error",
  "better-tailwindcss/no-duplicate-classes": "error",
  "better-tailwindcss/enforce-canonical-classes": "error",
  "better-tailwindcss/enforce-consistent-class-order": "error",
  "react/forbid-elements": [
    "error",
    {
      forbid: [
        shadcnComponent("button", "Button", "button"),
        shadcnComponent("input", "Input", "input"),
        shadcnComponent("textarea", "Textarea", "textarea"),
        shadcnComponent("select", "Select", "select"),
        shadcnComponent("table", "Table", "table"),
        shadcnComponent("dialog", "Dialog", "dialog"),
      ],
    },
  ],
}

const allOff = (rules) => Object.fromEntries(Object.keys(rules).map((rule) => [rule, "off"]))

const ALIAS_OR_RELATIVE = String.raw`^(@/|(\.{1,2}/)+)`

const folderImports = (folders, message, allowTypeImports = false) => ({
  regex: `${ALIAS_OR_RELATIVE}(${folders.join("|")})(/|$)`,
  message,
  allowTypeImports,
})

const databaseImports = folderImports(
  ["db"],
  "Only models/ talk to the database. Move this into a model. Type-only imports from db/generated are fine.",
  true,
)

const modelImportsFromEntries = folderImports(
  ["models"],
  'Pages, API routes and jobs never touch models/ or db/. Call a service instead (see AGENTS.md "How a request flows").',
  true,
)

const upwardImportsFromModels = folderImports(
  ["services", "jobs", "app", "components", "hooks"],
  "Models never call upward. They only talk to the database and never import services/, jobs/, app/, components/ or hooks/.",
)

const upwardImportsFromServices = folderImports(
  ["app", "components", "hooks"],
  "Services never call upward and hold nothing about the interface. Don't import app/, components/ or hooks/.",
)

const serverImportsFromBrowser = folderImports(
  ["services", "models", "jobs", "config"],
  "Browser-side code gets data from pages and the stream, never from server folders (services/, models/, jobs/, db/, config/).",
)

const upwardImportsFromFoundation = folderImports(
  ["services", "models", "jobs", "app", "components", "hooks"],
  "config/ and db/ sit at the bottom. They never import services/, models/, jobs/, app/, components/ or hooks/.",
)

const importRules = (patterns) => ({ "no-restricted-imports": ["error", { patterns }] })

const layers = [
  { files: ["**/*"], patterns: [databaseImports] },
  {
    files: ["src/app/**", "src/jobs/**", "src/instrumentation.ts"],
    patterns: [modelImportsFromEntries, databaseImports],
  },
  { files: ["src/services/**"], patterns: [upwardImportsFromServices, databaseImports] },
  { files: ["src/components/**", "src/hooks/**", "src/lib/**"], patterns: [serverImportsFromBrowser, databaseImports] },
  { files: ["src/config/**"], patterns: [upwardImportsFromFoundation, databaseImports] },
  { files: ["src/models/**"], patterns: [upwardImportsFromModels] },
  { files: ["src/db/**"], patterns: [upwardImportsFromFoundation] },
]

const TEST_FILES = ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "tests/**", "e2e/**"]

const testFilesIn = (folders) => folders.flatMap((folder) => TEST_FILES.map((testFile) => [folder, testFile]))

const layerRules = ({ files, patterns }) => ({ files, rules: importRules(patterns) })

const testLayerRules = ({ files, patterns }) => ({
  files: testFilesIn(files),
  rules: importRules(patterns.filter((pattern) => pattern !== databaseImports)),
})

const architectureRules = [...layers.map(layerRules), ...layers.map(testLayerRules)]

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.js", "*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { local, unicorn, sonarjs, functional, "prefer-arrow-functions": preferArrowFunctions },
    rules: {
      "local/no-comments": "error",
      "import/no-anonymous-default-export": "error",
      ...naming,
      ...builderStyle,
      ...arrowStyle,
    },
  },
  {
    files: ["**/*.tsx"],
    plugins: { shadcn, "better-tailwindcss": betterTailwind },
    settings: { "better-tailwindcss": { entryPoint: "src/app/globals.css", rootFontSize: 16 } },
    rules: interfaceRules,
  },
  {
    files: ["**/*.tsx"],
    rules: {
      "max-lines-per-function": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-statements": ["error", 10],
      complexity: ["error", { max: 10 }],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "tests/**", "e2e/**"],
    rules: {
      "max-lines-per-function": "off",
      "max-statements": "off",
      "max-nested-callbacks": ["error", 4],
      "no-restricted-syntax": ["error", ...arrowSyntax],
      "@typescript-eslint/naming-convention": namingConvention([TYPE_PREFIX]),
    },
  },
  {
    files: ["*.config.{js,cjs,mjs,ts,mts}"],
    rules: {
      ...allOff(builderStyle),
      "no-restricted-syntax": ["error", ...arrowSyntax],
      "id-length": "off",
      "unicorn/prevent-abbreviations": "off",
    },
  },
  {
    files: VENDORED,
    rules: {
      "local/no-comments": "off",
      ...allOff(naming),
      ...allOff(builderStyle),
      ...allOff(arrowStyle),
      ...allOff(interfaceRules),
    },
  },
  ...architectureRules,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/db/generated/**"]),
])
