import * as fs from "fs";
import * as os from "os";
import * as ts from "typescript-parser";
import * as vscode from "vscode";
import { Provider } from "./../provider";
import * as token from "./../tokens";
import { IBaseProvider } from "./base";

export class TypescriptProvider implements IBaseProvider<vscode.TreeItem> {
    private config: vscode.WorkspaceConfiguration;
    private parser: ts.TypescriptParser;
    private tree: Thenable<token.ITokenTree>;

    private readonly VISIBILITY = [
        "private", "protected", "public",
    ];

    public constructor() {
        this.parser = new ts.TypescriptParser();
        this.config = vscode.workspace.getConfiguration("treeview.js");
    }

    get roChar(): string {
        return this.config.has("readonlyCharacter") ?
            this.config.get("readonlyCharacter") : "@";
    }

    public hasSupport(langId: string): boolean {
        return langId.toLowerCase() === "typescript" ||
            langId.toLowerCase() === "javascript";
    }

    public refresh(document: vscode.TextDocument): void {
        this.config = vscode.workspace.getConfiguration("treeview.js");
        const useStrict = document.getText().toString().substr(1, 10) === "use strict";

        this.tree = this.parser.parseSource(document.getText()).then((raw: ts.File) => {
            const tree = {} as token.ITokenTree;
            tree.strict = useStrict;

            for (const dec of raw.declarations) {
                if (dec instanceof ts.ClassDeclaration) {
                    if (tree.classes === undefined) {
                        tree.classes = [];
                    }

                    if (dec instanceof ts.ClassDeclaration && dec.ctor !== undefined) {
                        dec.ctor.name = "constructor";
                        dec.methods.unshift(dec.ctor as ts.MethodDeclaration);
                    }

                    tree.classes.push({
                        methods: this.handleMethods(dec.methods),
                        name: dec.name,
                        properties: this.handleProperties(dec.properties),
                        visibility: dec.isExported === true ? "public" : "protected",
                    } as token.IClassToken);
                }

                if (dec instanceof ts.InterfaceDeclaration) {
                    if (tree.interfaces === undefined) {
                        tree.interfaces = [];
                    }
                    tree.interfaces.push({
                        methods: this.handleMethods(dec.methods),
                        name: dec.name,
                        properties: this.handleProperties(dec.properties)
                            .filter((p) => p.visibility === "public"),
                        visibility: dec.isExported === true ? "public" : "protected",
                    } as token.IInterfaceToken);
                }

                if (dec instanceof ts.VariableDeclaration) {
                    const startPosition = vscode.window.activeTextEditor.document.positionAt(dec.start);

                    if (tree.variables === undefined) {
                        tree.variables = [];
                    }

                    tree.variables.push({
                        name: `${dec.isConst ? this.roChar : ""}${dec.name}`,
                        position: this.generateRangeForSelection(dec.name, dec.start),
                        type: dec.type === undefined ? "any" : dec.type,
                        visibility: dec.isExported === true ? "public" : "protected",
                    } as token.IVariableToken);
                }

                if (dec instanceof ts.FunctionDeclaration) {
                    const startPosition = vscode.window.activeTextEditor.document.positionAt(dec.start);

                    if (tree.functions === undefined) {
                        tree.functions = [];
                    }

                    tree.functions.push({
                        arguments: this.handleArguments(dec.parameters),
                        name: dec.name,
                        position: this.generateRangeForSelection(dec.name, dec.start),
                        static: true,
                        type: dec.type === null ? "any" : dec.type,
                        visibility: dec.isExported === true ? "public" : "protected",
                    } as token.IMethodToken);
                }
            }

            for (const imp of raw.imports) {
                if (tree.imports === undefined) {
                    tree.imports = [];
                }

                if (imp instanceof ts.NamedImport && imp.specifiers !== undefined) {
                    const classes: string[] = [];
                    for (const spec of imp.specifiers) {
                        classes.push(spec.specifier);
                    }

                    tree.imports.push({
                        name: `${imp.libraryName}: ${classes.join(", ")}`,
                        position: new vscode.Range(
                            this.offsetToPosition(imp.start),
                            this.offsetToPosition(imp.start),
                        ),
                    } as token.ImportToken);
                }

                if (imp instanceof ts.NamespaceImport) {
                    tree.imports.push({
                        alias: imp.alias,
                        name: imp.libraryName,
                        position: new vscode.Range(
                            this.offsetToPosition(imp.start),
                            this.offsetToPosition(imp.start),
                        ),
                    } as token.ImportToken);
                }
            }

            return Promise.resolve(tree);
        });
    }

    public getTokenTree(): Thenable<token.ITokenTree> {
        return this.tree;
    }

    public getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }

    public getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        return Promise.resolve([]);
    }

    public getDocumentName(entityName: string, includeBodies: boolean = false): Thenable<string> {
        return vscode.window.showQuickPick([
            new QuickPickItem("JavaScript", "Will create a `.js` file", "js"),
            new QuickPickItem("TypeScript", "Will create a `.ts` file", "ts"),
        ], {
            ignoreFocusOut: true,
            placeHolder: "Chose file extension",
        }).then((r: QuickPickItem) => {
            return (includeBodies ?
                `${entityName}.${r.detail}` : `I${entityName}.ts`);
        });
    }

    public generate(
        entityName: string,
        skeleton: (token.IInterfaceToken | token.IClassToken),
        includeBodies: boolean,
        options: any = {},
    ): vscode.TextEdit[] {
        const edits: vscode.TextEdit[] = [];

        edits.push(new vscode.TextEdit(
            new vscode.Range(
                new vscode.Position(edits.length, 0),
                new vscode.Position(edits.length, 1024),
            ),
            `export ${!includeBodies ? "interface" : "class"} ${entityName} {` + os.EOL,
        ));

        if (skeleton.constants !== undefined) {
            const constants = skeleton.constants.filter((c) => c.visibility === "public");
            for (const constant of constants) {
                const line = `    ` +
                    `public static readonly ${constant.name} = ${constant.value};`;

                edits.push(new vscode.TextEdit(
                    new vscode.Range(
                        new vscode.Position(edits.length, 0),
                        new vscode.Position(edits.length, line.length),
                    ),
                    line + os.EOL,
                ));

                if (constants.indexOf(constant) === constants.length - 1 &&
                    skeleton.methods.length !== 0) {
                    const constantPosition = skeleton.constants.indexOf(constant);
                    edits.push(new vscode.TextEdit(
                        new vscode.Range(
                            new vscode.Position(edits.length, 0),
                            new vscode.Position(edits.length, 1),
                        ),
                        os.EOL,
                    ));
                }
            }
        }

        if (skeleton.methods !== undefined) {
            const methods = skeleton.methods.filter((m) => m.visibility === "public");
            for (const method of methods) {
                let body = ";";
                if (includeBodies) {
                    body = `${os.EOL}    {` +
                        `        throw new Error(\"Not implemented\");`
                        + `${os.EOL}    }` + (methods.indexOf(method) === methods.length - 1 ? "" : os.EOL);
                }

                const args: string[] = [];
                for (const arg of method.arguments) {
                    args.push(
                        `${arg.name}: ${arg.type}${arg.value !== "" ? ` = ${arg.value}` : ""}`,
                    );
                }
                const returnType: string = method.type !== undefined && method.type !== "mixed" ?
                    method.type : "";

                const line = `    public ${method.name}(${args.join(", ")})` +
                    `${returnType !== "" ? `: ${returnType}` : ""}${body}`;

                edits.push(new vscode.TextEdit(
                    new vscode.Range(
                        new vscode.Position(edits.length + (includeBodies ? 2 : 0), 0),
                        new vscode.Position(edits.length + (includeBodies ? 2 : 0), line.length),
                    ),
                    line + os.EOL,
                ));
            }
        }

        edits.push(new vscode.TextEdit(
            new vscode.Range(
                new vscode.Position(edits.length + (includeBodies ? 2 : 0), 0),
                new vscode.Position(edits.length + (includeBodies ? 2 : 0), 1024),
            ),
            "}" + os.EOL,
        ));

        return edits;
    }

    private handleProperties(children: any[]): token.IPropertyToken[] {
        const properties: token.IPropertyToken[] = [];

        for (const property of children) {
            const def = vscode.window.activeTextEditor.document.getText(new vscode.Range(
                this.offsetToPosition(property.start),
                this.offsetToPosition(property.end),
            )).split(" ").slice(0, 5);

            properties.push({
                name: (def.indexOf("readonly") > -1 ? this.roChar : "") + property.name,
                position: this.generateRangeForSelection(property.name, property.start),
                readonly: (def.indexOf("readonly") > -1),
                static: (def.indexOf("static") > -1),
                type: property.type === undefined ? "any" : property.type,
                value: this.normalizeType(property.value, property.type),
                visibility: this.VISIBILITY[property.visibility === undefined ? 2 : property.visibility],
            } as token.IPropertyToken);
        }

        return properties;
    }

    private normalizeType(value, type): string {
        if (value === null || value === undefined) { return ""; }

        let val;
        switch (type) {
            case "array":
                let arr: any;
                for (const x of value.items) {
                    if (x.key === null) {
                        if (arr === undefined) { arr = []; }
                        arr.push(x.value.value);
                    } else {
                        if (arr === undefined) { arr = {}; }
                        arr[x.key] = x.value.value;
                    }
                }

                val = JSON.stringify(arr);
                break;
            case "string":
                val = `"${value}"`;
                break;
            default:
                val = value;
                break;
        }
        return val;
    }

    private handleMethods(children: ts.MethodDeclaration[]): token.IMethodToken[] {
        const methods: token.IMethodToken[] = [];

        for (const method of children) {
            const def = vscode.window.activeTextEditor.document.getText(new vscode.Range(
                this.offsetToPosition(method.start),
                this.offsetToPosition(method.end),
            )).split(" ").slice(0, 5);

            methods.push({
                arguments: this.handleArguments(method.parameters),
                name: method.name,
                position: this.generateRangeForSelection(method.name, method.start),
                static: (def.indexOf("static") > -1),
                type: method.name !== "constructor" ? (method.type === undefined ? "any" : method.type) : undefined,
                visibility: this.VISIBILITY[method.visibility === undefined ? 2 : method.visibility],
            } as token.IMethodToken);
        }

        return methods;
    }

    private handleArguments(children: any[]): token.IVariableToken[] {
        const variables: token.IVariableToken[] = [];

        for (const variable of children) {
            variables.push({
                name: variable.name,
                type: variable.type === null ? "any" : variable.type,
                value: variable.value === undefined ? "" : this.normalizeType(variable.value, variable.type),
                visibility: variable.visibility === undefined ? "public" : variable.visibility,
            } as token.IVariableToken);
        }

        return variables;
    }

    private offsetToPosition(offset: number): vscode.Position {
        return vscode.window.activeTextEditor.document.positionAt(offset);
    }

    private generateRangeForSelection(name: string, offset: number): vscode.Range {
        const startPosition = this.offsetToPosition(offset);
        const line = vscode.window.activeTextEditor.document.lineAt(startPosition.line).text;

        const startIndex = line.indexOf(name);
        if (startIndex === line.lastIndexOf(name)) {
            return new vscode.Range(
                new vscode.Position(startPosition.line, startIndex),
                new vscode.Position(startPosition.line, startIndex + name.length),
            );
        }

        return new vscode.Range(
            new vscode.Position(startPosition.line, startIndex),
            new vscode.Position(startPosition.line, startIndex),
        );
    }
}

class QuickPickItem implements vscode.QuickPickItem {
    constructor(public label, public description, public detail?) {}
}
