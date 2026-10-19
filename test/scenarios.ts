/** Real repos and issues whose GitHub responses are recorded in test/fixtures. */
export const SCENARIOS = [
  { name: "black-5260", repo: "psf/black", issue: 5260 },
  { name: "pylint-9187", repo: "pylint-dev/pylint", issue: 9187 },
  { name: "sqlfluff-8705", repo: "sqlfluff/sqlfluff", issue: 8705 },
  { name: "sqlfluff-8721", repo: "sqlfluff/sqlfluff", issue: 8721 },
  { name: "sphinx-4248", repo: "sphinx-doc/sphinx", issue: 4248 },
  { name: "pydantic-11692", repo: "pydantic/pydantic", issue: 11692 },
  { name: "vite", repo: "vitejs/vite", issue: null },
  { name: "cherry-studio", repo: "CherryHQ/cherry-studio", issue: null },
] as const;
