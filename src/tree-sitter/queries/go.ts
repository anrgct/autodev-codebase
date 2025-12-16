/*
Go Tree-Sitter Query Patterns

Capture top-level declarations (package/import/types/functions/vars/consts).
*/
export default `
; Package clause
(package_clause) @definition.package

; Import declarations (single or import blocks)
(import_declaration) @definition.import

; Const/var blocks
(const_declaration) @definition.const
(var_declaration) @definition.var

; Type declarations (interfaces, structs, aliases)
(type_declaration) @definition.type

; Functions and methods
(function_declaration) @definition.function
(method_declaration) @definition.method
`
