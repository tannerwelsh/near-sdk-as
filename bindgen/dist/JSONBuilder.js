"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JSONBindingsBuilder = exports.isEntry = void 0;
const as_1 = require("visitor-as/as");
const visitor_as_1 = require("visitor-as");
const utils_1 = require("./utils");
const NEAR_DECORATOR = "nearBindgen";
function returnsVoid(node) {
    return utils_1.toString(node.signature.returnType) === "void";
}
function numOfParameters(node) {
    return node.signature.parameters.length;
}
function hasNearDecorator(stmt) {
    return ((stmt.text.includes("@nearfile") ||
        stmt.text.includes("@" + NEAR_DECORATOR) ||
        isEntry(stmt)) &&
        !stmt.text.includes("@notNearfile"));
}
function isEntry(source) {
    return source.range.source.sourceKind == as_1.SourceKind.USER_ENTRY;
}
exports.isEntry = isEntry;
function isClass(type) {
    return type.kind == as_1.NodeKind.CLASSDECLARATION;
}
function isField(mem) {
    return mem.kind == as_1.NodeKind.FIELDDECLARATION;
}
function isPayable(func) {
    return (func.decorators != null &&
        func.decorators.some((s) => utils_1.toString(s.name) != "payable"));
}
function createDecodeStatements(_class) {
    return _class.members
        .filter(isField)
        .map((field) => {
        const name = utils_1.toString(field.name);
        return (createDecodeStatement(field, `this.${name} = obj.has("${name}") ? `) +
            `: ${field.initializer != null
                ? utils_1.toString(field.initializer)
                : `this.${name}`};`);
    });
}
function createDecodeStatement(field, setterPrefix = "") {
    let T = utils_1.toString(field.type);
    let name = utils_1.toString(field.name);
    return `${setterPrefix}decode<${T}, JSON.Obj>(obj, "${name}")`;
}
function createEncodeStatements(_class) {
    return _class.members
        .filter(isField)
        .map((field) => {
        let T = utils_1.toString(field.type);
        let name = utils_1.toString(field.name);
        return `encode<${T}, JSONEncoder>(this.${name}, "${name}", encoder);`;
    });
}
// TODO: Extract this into separate module, preferrable pluggable
class JSONBindingsBuilder extends visitor_as_1.BaseVisitor {
    constructor() {
        super(...arguments);
        this.sb = [];
        this.exportedClasses = new Map();
        this.wrappedFuncs = new Set();
    }
    static build(source) {
        return new JSONBindingsBuilder().build(source);
    }
    static nearFiles(sources) {
        return sources.filter(hasNearDecorator);
    }
    visitClassDeclaration(node) {
        if (!this.exportedClasses.has(utils_1.toString(node.name))) {
            this.exportedClasses.set(utils_1.toString(node.name), node);
        }
        super.visitClassDeclaration(node);
    }
    visitFunctionDeclaration(node) {
        if (!isEntry(node) ||
            this.wrappedFuncs.has(utils_1.toString(node.name)) ||
            !node.is(as_1.CommonFlags.EXPORT) ||
            (numOfParameters(node) == 0 && returnsVoid(node))) {
            super.visitFunctionDeclaration(node);
            return;
        }
        this.generateWrapperFunction(node);
        // Change function to not be an export
        node.flags = node.flags ^ as_1.CommonFlags.EXPORT;
        this.wrappedFuncs.add(utils_1.toString(node.name));
        super.visit(node);
    }
    /*
    Create a wrapper function that will be export in the function's place.
    */
    generateWrapperFunction(func) {
        let signature = func.signature;
        let params = signature.parameters;
        let returnType = signature.returnType;
        let returnTypeName = utils_1.toString(returnType)
            .split("|")
            .map((name) => name.trim())
            .filter((name) => name !== "null")
            .join("|");
        let hasNull = utils_1.toString(returnType).includes("null");
        let name = func.name.text;
        if (func.decorators && func.decorators.length > 0) {
            this.sb.push(func.decorators.map(decorator => utils_1.toString(decorator)).join("\n"));
        }
        this.sb.push(`function __wrapper_${name}(): void {`);
        if (params.length > 0) {
            this.sb.push(`  const obj = getInput();`);
        }
        if (utils_1.toString(returnType) !== "void") {
            this.sb.push(`  let result: ${utils_1.toString(returnType)} = ${name}(`);
        }
        else {
            this.sb.push(`  ${name}(`);
        }
        if (params.length > 0) {
            this.sb[this.sb.length - 1] += params
                .map((param) => {
                let name = utils_1.toString(param.name);
                let type = utils_1.toString(param.type);
                let res = `obj.has('${name}') ? 
             ${createDecodeStatement(param)} : 
             assertNonNull<${type}>('${name}', changetype<${type}>(${param.initializer ? utils_1.toString(param.initializer) : "0"}))`;
                return res;
            })
                .join(", ");
        }
        this.sb[this.sb.length - 1] += ");";
        if (utils_1.toString(returnType) !== "void") {
            this.sb.push(`  const val = encode<${returnTypeName}>(${hasNull ? `changetype<${returnTypeName}>(result)` : "result"});
  value_return(val.byteLength, val.dataStart);`);
        }
        this.sb.push(`}
export { __wrapper_${name} as ${name} }`);
    }
    typeName(type) {
        if (!isClass(type)) {
            return utils_1.toString(type);
        }
        type = type;
        let className = utils_1.toString(type.name);
        if (type.isGeneric) {
            className += "<" + type.typeParameters.map(utils_1.toString).join(", ") + ">";
        }
        return className;
    }
    build(source) {
        const isNearFile = source.text.includes("@nearfile");
        this.sb = [];
        this.visit(source);
        let sourceText = source.statements.map((stmt) => {
            let str;
            if (isClass(stmt) &&
                (visitor_as_1.utils.hasDecorator(stmt, NEAR_DECORATOR) ||
                    isNearFile)) {
                let _class = stmt;
                let fields = _class.members
                    .filter(isField)
                    .map((field) => field);
                if (fields.some((field) => field.type == null)) {
                    throw new Error("All Fields must have explict type declaration.");
                }
                fields.forEach((field) => {
                    if (field.initializer == null) {
                        field.initializer = utils_1.SimpleParser.parseExpression(`defaultValue<${utils_1.toString(field.type)}>())`);
                    }
                });
                str = utils_1.toString(stmt);
                str = str.slice(0, str.lastIndexOf("}"));
                let className = this.typeName(_class);
                if (!visitor_as_1.utils.hasDecorator(stmt, NEAR_DECORATOR)) {
                    console.error("\x1b[31m", `@nearfile is deprecated use @${NEAR_DECORATOR} decorator on ${className}`, "\x1b[0m");
                }
                str += `
  decode<_V = Uint8Array>(buf: _V): ${className} {
    let json: JSON.Obj;
    if (buf instanceof Uint8Array) {
      json = JSON.parse(buf);
    } else {
      assert(buf instanceof JSON.Obj, "argument must be Uint8Array or Json Object");
      json = <JSON.Obj> buf;
    }
    return this._decode(json);
  }

  static decode(buf: Uint8Array): ${className} {
    return decode<${className}>(buf);
  }

  private _decode(obj: JSON.Obj): ${className} {
    ${createDecodeStatements(_class).join("\n    ")}
    return this;
  }

  _encode(name: string | null = "", _encoder: JSONEncoder | null = null): JSONEncoder {
    let encoder = _encoder == null ? new JSONEncoder() : _encoder;
    encoder.pushObject(name);
    ${createEncodeStatements(_class).join("\n    ")}
    encoder.popObject();
    return encoder;
  }
  encode(): Uint8Array {
    return this._encode().serialize();
  }

  serialize(): Uint8Array {
    return this.encode();
  }

  toJSON(): string {
    return this._encode().toString();
  }
}`;
            }
            else {
                str = utils_1.toString(stmt);
            }
            return str;
        });
        return sourceText.concat(this.sb).join("\n");
    }
}
exports.JSONBindingsBuilder = JSONBindingsBuilder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiSlNPTkJ1aWxkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvSlNPTkJ1aWxkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsc0NBYXVCO0FBQ3ZCLDJDQUFnRDtBQUNoRCxtQ0FBaUQ7QUFFakQsTUFBTSxjQUFjLEdBQUcsYUFBYSxDQUFDO0FBRXJDLFNBQVMsV0FBVyxDQUFDLElBQXlCO0lBQzVDLE9BQU8sZ0JBQVEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxLQUFLLE1BQU0sQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsSUFBeUI7SUFDaEQsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUM7QUFDMUMsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsSUFBWTtJQUNwQyxPQUFPLENBQ0wsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUM7UUFDOUIsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxHQUFHLGNBQWMsQ0FBQztRQUN4QyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDaEIsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FDcEMsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFnQixPQUFPLENBQUMsTUFBcUI7SUFDM0MsT0FBTyxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxVQUFVLElBQUksZUFBVSxDQUFDLFVBQVUsQ0FBQztBQUNqRSxDQUFDO0FBRkQsMEJBRUM7QUFFRCxTQUFTLE9BQU8sQ0FBQyxJQUFVO0lBQ3pCLE9BQU8sSUFBSSxDQUFDLElBQUksSUFBSSxhQUFRLENBQUMsZ0JBQWdCLENBQUM7QUFDaEQsQ0FBQztBQUVELFNBQVMsT0FBTyxDQUFDLEdBQXlCO0lBQ3hDLE9BQU8sR0FBRyxDQUFDLElBQUksSUFBSSxhQUFRLENBQUMs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a0RBdUxDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtcbiAgTm9kZSxcbiAgRnVuY3Rpb25EZWNsYXJhdGlvbixcbiAgTm9kZUtpbmQsXG4gIFNvdXJjZSxcbiAgU291cmNlS2luZCxcbiAgVHlwZU5vZGUsXG4gIENsYXNzRGVjbGFyYXRpb24sXG4gIERlY2xhcmF0aW9uU3RhdGVtZW50LFxuICBDb21tb25GbGFncyxcbiAgRmllbGREZWNsYXJhdGlvbixcbiAgUGFyYW1ldGVyTm9kZSxcbiAgQmxvY2tTdGF0ZW1lbnQsXG59IGZyb20gXCJ2aXNpdG9yLWFzL2FzXCI7XG5pbXBvcnQgeyBCYXNlVmlzaXRvciwgdXRpbHMgfSBmcm9tIFwidmlzaXRvci1hc1wiO1xuaW1wb3J0IHsgU2ltcGxlUGFyc2VyLCB0b1N0cmluZyB9IGZyb20gXCIuL3V0aWxzXCI7XG5cbmNvbnN0IE5FQVJfREVDT1JBVE9SID0gXCJuZWFyQmluZGdlblwiO1xuXG5mdW5jdGlvbiByZXR1cm5zVm9pZChub2RlOiBGdW5jdGlvbkRlY2xhcmF0aW9uKTogYm9vbGVhbiB7XG4gIHJldHVybiB0b1N0cmluZyhub2RlLnNpZ25hdHVyZS5yZXR1cm5UeXBlKSA9PT0gXCJ2b2lkXCI7XG59XG5cbmZ1bmN0aW9uIG51bU9mUGFyYW1ldGVycyhub2RlOiBGdW5jdGlvbkRlY2xhcmF0aW9uKTogbnVtYmVyIHtcbiAgcmV0dXJuIG5vZGUuc2lnbmF0dXJlLnBhcmFtZXRlcnMubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiBoYXNOZWFyRGVjb3JhdG9yKHN0bXQ6IFNvdXJjZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIChzdG10LnRleHQuaW5jbHVkZXMoXCJAbmVhcmZpbGVcIikgfHxcbiAgICAgIHN0bXQudGV4dC5pbmNsdWRlcyhcIkBcIiArIE5FQVJfREVDT1JBVE9SKSB8fFxuICAgICAgaXNFbnRyeShzdG10KSkgJiZcbiAgICAhc3RtdC50ZXh0LmluY2x1ZGVzKFwiQG5vdE5lYXJmaWxlXCIpXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0VudHJ5KHNvdXJjZTogU291cmNlIHwgTm9kZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gc291cmNlLnJhbmdlLnNvdXJjZS5zb3VyY2VLaW5kID09IFNvdXJjZUtpbmQuVVNFUl9FTlRSWTtcbn1cblxuZnVuY3Rpb24gaXNDbGFzcyh0eXBlOiBOb2RlKTogYm9vbGVhbiB7XG4gIHJldHVybiB0eXBlLmtpbmQgPT0gTm9kZUtpbmQuQ0xBU1NERUNMQVJBVElPTjtcbn1cblxuZnVuY3Rpb24gaXNGaWVsZChtZW06IERlY2xhcmF0aW9uU3RhdGVtZW50KSB7XG4gIHJldHVybiBtZW0ua2luZCA9PSBOb2RlS2luZC5GSUVMRERFQ0xBUkFUSU9OO1xufVxuXG5mdW5jdGlvbiBpc1BheWFibGUoZnVuYzogRnVuY3Rpb25EZWNsYXJhdGlvbik6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIGZ1bmMuZGVjb3JhdG9ycyAhPSBudWxsICYmXG4gICAgZnVuYy5kZWNvcmF0b3JzLnNvbWUoKHMpID0+IHRvU3RyaW5nKHMubmFtZSkgIT0gXCJwYXlhYmxlXCIpXG4gICk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZURlY29kZVN0YXRlbWVudHMoX2NsYXNzOiBDbGFzc0RlY2xhcmF0aW9uKTogc3RyaW5nW10ge1xuICByZXR1cm4gX2NsYXNzLm1lbWJlcnNcbiAgICAuZmlsdGVyKGlzRmllbGQpXG4gICAgLm1hcCgoZmllbGQ6IEZpZWxkRGVjbGFyYXRpb24pOiBzdHJpbmcgPT4ge1xuICAgICAgY29uc3QgbmFtZSA9IHRvU3RyaW5nKGZpZWxkLm5hbWUpO1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgY3JlYXRlRGVjb2RlU3RhdGVtZW50KGZpZWxkLCBgdGhpcy4ke25hbWV9ID0gb2JqLmhhcyhcIiR7bmFtZX1cIikgPyBgKSArXG4gICAgICAgIGA6ICR7XG4gICAgICAgICAgZmllbGQuaW5pdGlhbGl6ZXIgIT0gbnVsbFxuICAgICAgICAgICAgPyB0b1N0cmluZyhmaWVsZC5pbml0aWFsaXplcilcbiAgICAgICAgICAgIDogYHRoaXMuJHtuYW1lfWBcbiAgICAgICAgfTtgXG4gICAgICApO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVEZWNvZGVTdGF0ZW1lbnQoXG4gIGZpZWxkOiBGaWVsZERlY2xhcmF0aW9uIHwgUGFyYW1ldGVyTm9kZSxcbiAgc2V0dGVyUHJlZml4OiBzdHJpbmcgPSBcIlwiXG4pOiBzdHJpbmcge1xuICBsZXQgVCA9IHRvU3RyaW5nKGZpZWxkLnR5cGUhKTtcbiAgbGV0IG5hbWUgPSB0b1N0cmluZyhmaWVsZC5uYW1lKTtcbiAgcmV0dXJuIGAke3NldHRlclByZWZpeH1kZWNvZGU8JHtUfSwgSlNPTi5PYmo+KG9iaiwgXCIke25hbWV9XCIpYDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRW5jb2RlU3RhdGVtZW50cyhfY2xhc3M6IENsYXNzRGVjbGFyYXRpb24pOiBzdHJpbmdbXSB7XG4gIHJldHVybiBfY2xhc3MubWVtYmVyc1xuICAgIC5maWx0ZXIoaXNGaWVsZClcbiAgICAubWFwKChmaWVsZDogRmllbGREZWNsYXJhdGlvbik6IHN0cmluZyA9PiB7XG4gICAgICBsZXQgVCA9IHRvU3RyaW5nKGZpZWxkLnR5cGUhKTtcbiAgICAgIGxldCBuYW1lID0gdG9TdHJpbmcoZmllbGQubmFtZSk7XG4gICAgICByZXR1cm4gYGVuY29kZTwke1R9LCBKU09ORW5jb2Rlcj4odGhpcy4ke25hbWV9LCBcIiR7bmFtZX1cIiwgZW5jb2Rlcik7YDtcbiAgICB9KTtcbn1cblxuLy8gVE9ETzogRXh0cmFjdCB0aGlzIGludG8gc2VwYXJhdGUgbW9kdWxlLCBwcmVmZXJyYWJsZSBwbHVnZ2FibGVcbmV4cG9ydCBjbGFzcyBKU09OQmluZGluZ3NCdWlsZGVyIGV4dGVuZHMgQmFzZVZpc2l0b3Ige1xuICBwcml2YXRlIHNiOiBzdHJpbmdbXSA9IFtdO1xuICBwcml2YXRlIGV4cG9ydGVkQ2xhc3NlczogTWFwPHN0cmluZywgQ2xhc3NEZWNsYXJhdGlvbj4gPSBuZXcgTWFwKCk7XG4gIHdyYXBwZWRGdW5jczogU2V0PHN0cmluZz4gPSBuZXcgU2V0KCk7XG5cbiAgc3RhdGljIGJ1aWxkKHNvdXJjZTogU291cmNlKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbmV3IEpTT05CaW5kaW5nc0J1aWxkZXIoKS5idWlsZChzb3VyY2UpO1xuICB9XG5cbiAgc3RhdGljIG5lYXJGaWxlcyhzb3VyY2VzOiBTb3VyY2VbXSk6IFNvdXJjZVtdIHtcbiAgICByZXR1cm4gc291cmNlcy5maWx0ZXIoaGFzTmVhckRlY29yYXRvcik7XG4gIH1cblxuICB2aXNpdENsYXNzRGVjbGFyYXRpb24obm9kZTogQ2xhc3NEZWNsYXJhdGlvbik6IHZvaWQge1xuICAgIGlmICghdGhpcy5leHBvcnRlZENsYXNzZXMuaGFzKHRvU3RyaW5nKG5vZGUubmFtZSkpKSB7XG4gICAgICB0aGlzLmV4cG9ydGVkQ2xhc3Nlcy5zZXQodG9TdHJpbmcobm9kZS5uYW1lKSwgbm9kZSk7XG4gICAgfVxuICAgIHN1cGVyLnZpc2l0Q2xhc3NEZWNsYXJhdGlvbihub2RlKTtcbiAgfVxuXG4gIHZpc2l0RnVuY3Rpb25EZWNsYXJhdGlvbihub2RlOiBGdW5jdGlvbkRlY2xhcmF0aW9uKTogdm9pZCB7XG4gICAgaWYgKFxuICAgICAgIWlzRW50cnkobm9kZSkgfHxcbiAgICAgIHRoaXMud3JhcHBlZEZ1bmNzLmhhcyh0b1N0cmluZyhub2RlLm5hbWUpKSB8fFxuICAgICAgIW5vZGUuaXMoQ29tbW9uRmxhZ3MuRVhQT1JUKSB8fFxuICAgICAgKG51bU9mUGFyYW1ldGVycyhub2RlKSA9PSAwICYmIHJldHVybnNWb2lkKG5vZGUpKVxuICAgICkge1xuICAgICAgc3VwZXIudmlzaXRGdW5jdGlvbkRlY2xhcmF0aW9uKG5vZGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLmdlbmVyYXRlV3JhcHBlckZ1bmN0aW9uKG5vZGUpO1xuICAgIC8vIENoYW5nZSBmdW5jdGlvbiB0byBub3QgYmUgYW4gZXhwb3J0XG4gICAgbm9kZS5mbGFncyA9IG5vZGUuZmxhZ3MgXiBDb21tb25GbGFncy5FWFBPUlQ7XG4gICAgdGhpcy53cmFwcGVkRnVuY3MuYWRkKHRvU3RyaW5nKG5vZGUubmFtZSkpO1xuICAgIHN1cGVyLnZpc2l0KG5vZGUpO1xuICB9XG5cbiAgLypcbiAgQ3JlYXRlIGEgd3JhcHBlciBmdW5jdGlvbiB0aGF0IHdpbGwgYmUgZXhwb3J0IGluIHRoZSBmdW5jdGlvbidzIHBsYWNlLlxuICAqL1xuICBwcml2YXRlIGdlbmVyYXRlV3JhcHBlckZ1bmN0aW9uKGZ1bmM6IEZ1bmN0aW9uRGVjbGFyYXRpb24pIHtcbiAgICBsZXQgc2lnbmF0dXJlID0gZnVuYy5zaWduYXR1cmU7XG4gICAgbGV0IHBhcmFtcyA9IHNpZ25hdHVyZS5wYXJhbWV0ZXJzO1xuICAgIGxldCByZXR1cm5UeXBlID0gc2lnbmF0dXJlLnJldHVyblR5cGU7XG4gICAgbGV0IHJldHVyblR5cGVOYW1lID0gdG9TdHJpbmcocmV0dXJuVHlwZSlcbiAgICAgIC5zcGxpdChcInxcIilcbiAgICAgIC5tYXAoKG5hbWUpID0+IG5hbWUudHJpbSgpKVxuICAgICAgLmZpbHRlcigobmFtZSkgPT4gbmFtZSAhPT0gXCJudWxsXCIpXG4gICAgICAuam9pbihcInxcIik7XG4gICAgbGV0IGhhc051bGwgPSB0b1N0cmluZyhyZXR1cm5UeXBlKS5pbmNsdWRlcyhcIm51bGxcIik7XG4gICAgbGV0IG5hbWUgPSBmdW5jLm5hbWUudGV4dDtcbiAgICBpZiAoZnVuYy5kZWNvcmF0b3JzICYmIGZ1bmMuZGVjb3JhdG9ycy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLnNiLnB1c2goZnVuYy5kZWNvcmF0b3JzLm1hcChkZWNvcmF0b3IgPT4gdG9TdHJpbmcoZGVjb3JhdG9yKSkuam9pbihcIlxcblwiKSlcbiAgICB9XG4gICAgdGhpcy5zYi5wdXNoKGBmdW5jdGlvbiBfX3dyYXBwZXJfJHtuYW1lfSgpOiB2b2lkIHtgKTtcbiAgICBpZiAocGFyYW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIHRoaXMuc2IucHVzaChgICBjb25zdCBvYmogPSBnZXRJbnB1dCgpO2ApO1xuICAgIH1cbiAgICBpZiAodG9TdHJpbmcocmV0dXJuVHlwZSkgIT09IFwidm9pZFwiKSB7XG4gICAgICB0aGlzLnNiLnB1c2goYCAgbGV0IHJlc3VsdDogJHt0b1N0cmluZyhyZXR1cm5UeXBlKX0gPSAke25hbWV9KGApO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNiLnB1c2goYCAgJHtuYW1lfShgKTtcbiAgICB9XG4gICAgaWYgKHBhcmFtcy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLnNiW3RoaXMuc2IubGVuZ3RoIC0gMV0gKz0gcGFyYW1zXG4gICAgICAgIC5tYXAoKHBhcmFtKSA9PiB7XG4gICAgICAgICAgbGV0IG5hbWUgPSB0b1N0cmluZyhwYXJhbS5uYW1lKTtcbiAgICAgICAgICBsZXQgdHlwZSA9IHRvU3RyaW5nKHBhcmFtLnR5cGUpO1xuICAgICAgICAgIGxldCByZXMgPSBgb2JqLmhhcygnJHtuYW1lfScpID8gXG4gICAgICAgICAgICAgJHtjcmVhdGVEZWNvZGVTdGF0ZW1lbnQocGFyYW0pfSA6IFxuICAgICAgICAgICAgIGFzc2VydE5vbk51bGw8JHt0eXBlfT4oJyR7bmFtZX0nLCBjaGFuZ2V0eXBlPCR7dHlwZX0+KCR7XG4gICAgICAgICAgICBwYXJhbS5pbml0aWFsaXplciA/IHRvU3RyaW5nKHBhcmFtLmluaXRpYWxpemVyKSA6IFwiMFwiXG4gICAgICAgICAgfSkpYDtcbiAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9KVxuICAgICAgICAuam9pbihcIiwgXCIpO1xuICAgIH1cbiAgICB0aGlzLnNiW3RoaXMuc2IubGVuZ3RoIC0gMV0gKz0gXCIpO1wiO1xuICAgIGlmICh0b1N0cmluZyhyZXR1cm5UeXBlKSAhPT0gXCJ2b2lkXCIpIHtcbiAgICAgIHRoaXMuc2IucHVzaChgICBjb25zdCB2YWwgPSBlbmNvZGU8JHtyZXR1cm5UeXBlTmFtZX0+KCR7XG4gICAgICAgIGhhc051bGwgPyBgY2hhbmdldHlwZTwke3JldHVyblR5cGVOYW1lfT4ocmVzdWx0KWAgOiBcInJlc3VsdFwiXG4gICAgICB9KTtcbiAgdmFsdWVfcmV0dXJuKHZhbC5ieXRlTGVuZ3RoLCB2YWwuZGF0YVN0YXJ0KTtgKTtcbiAgICB9XG4gICAgdGhpcy5zYi5wdXNoKGB9XG5leHBvcnQgeyBfX3dyYXBwZXJfJHtuYW1lfSBhcyAke25hbWV9IH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgdHlwZU5hbWUodHlwZTogVHlwZU5vZGUgfCBDbGFzc0RlY2xhcmF0aW9uKTogc3RyaW5nIHtcbiAgICBpZiAoIWlzQ2xhc3ModHlwZSkpIHtcbiAgICAgIHJldHVybiB0b1N0cmluZyh0eXBlKTtcbiAgICB9XG4gICAgdHlwZSA9IDxDbGFzc0RlY2xhcmF0aW9uPnR5cGU7XG4gICAgbGV0IGNsYXNzTmFtZSA9IHRvU3RyaW5nKHR5cGUubmFtZSk7XG4gICAgaWYgKHR5cGUuaXNHZW5lcmljKSB7XG4gICAgICBjbGFzc05hbWUgKz0gXCI8XCIgKyB0eXBlLnR5cGVQYXJhbWV0ZXJzIS5tYXAodG9TdHJpbmcpLmpvaW4oXCIsIFwiKSArIFwiPlwiO1xuICAgIH1cbiAgICByZXR1cm4gY2xhc3NOYW1lO1xuICB9XG5cbiAgYnVpbGQoc291cmNlOiBTb3VyY2UpOiBzdHJpbmcge1xuICAgIGNvbnN0IGlzTmVhckZpbGUgPSBzb3VyY2UudGV4dC5pbmNsdWRlcyhcIkBuZWFyZmlsZVwiKTtcbiAgICB0aGlzLnNiID0gW107XG4gICAgdGhpcy52aXNpdChzb3VyY2UpO1xuXG4gICAgbGV0IHNvdXJjZVRleHQgPSBzb3VyY2Uuc3RhdGVtZW50cy5tYXAoKHN0bXQpID0+IHtcbiAgICAgIGxldCBzdHI7XG4gICAgICBpZiAoXG4gICAgICAgIGlzQ2xhc3Moc3RtdCkgJiZcbiAgICAgICAgKHV0aWxzLmhhc0RlY29yYXRvcig8Q2xhc3NEZWNsYXJhdGlvbj5zdG10LCBORUFSX0RFQ09SQVRPUikgfHxcbiAgICAgICAgICBpc05lYXJGaWxlKVxuICAgICAgKSB7XG4gICAgICAgIGxldCBfY2xhc3MgPSA8Q2xhc3NEZWNsYXJhdGlvbj5zdG10O1xuICAgICAgICBsZXQgZmllbGRzID0gX2NsYXNzLm1lbWJlcnNcbiAgICAgICAgICAuZmlsdGVyKGlzRmllbGQpXG4gICAgICAgICAgLm1hcCgoZmllbGQ6IEZpZWxkRGVjbGFyYXRpb24pID0+IGZpZWxkKTtcbiAgICAgICAgaWYgKGZpZWxkcy5zb21lKChmaWVsZCkgPT4gZmllbGQudHlwZSA9PSBudWxsKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFsbCBGaWVsZHMgbXVzdCBoYXZlIGV4cGxpY3QgdHlwZSBkZWNsYXJhdGlvbi5cIik7XG4gICAgICAgIH1cbiAgICAgICAgZmllbGRzLmZvckVhY2goKGZpZWxkKSA9PiB7XG4gICAgICAgICAgaWYgKGZpZWxkLmluaXRpYWxpemVyID09IG51bGwpIHtcbiAgICAgICAgICAgIGZpZWxkLmluaXRpYWxpemVyID0gU2ltcGxlUGFyc2VyLnBhcnNlRXhwcmVzc2lvbihcbiAgICAgICAgICAgICAgYGRlZmF1bHRWYWx1ZTwke3RvU3RyaW5nKGZpZWxkLnR5cGUhKX0+KCkpYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBzdHIgPSB0b1N0cmluZyhzdG10KTtcbiAgICAgICAgc3RyID0gc3RyLnNsaWNlKDAsIHN0ci5sYXN0SW5kZXhPZihcIn1cIikpO1xuICAgICAgICBsZXQgY2xhc3NOYW1lID0gdGhpcy50eXBlTmFtZShfY2xhc3MpO1xuICAgICAgICBpZiAoIXV0aWxzLmhhc0RlY29yYXRvcig8Q2xhc3NEZWNsYXJhdGlvbj5zdG10LCBORUFSX0RFQ09SQVRPUikpIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgXCJcXHgxYlszMW1cIixcbiAgICAgICAgICAgIGBAbmVhcmZpbGUgaXMgZGVwcmVjYXRlZCB1c2UgQCR7TkVBUl9ERUNPUkFUT1J9IGRlY29yYXRvciBvbiAke2NsYXNzTmFtZX1gLFxuICAgICAgICAgICAgXCJcXHgxYlswbVwiXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBzdHIgKz0gYFxuICBkZWNvZGU8X1YgPSBVaW50OEFycmF5PihidWY6IF9WKTogJHtjbGFzc05hbWV9IHtcbiAgICBsZXQganNvbjogSlNPTi5PYmo7XG4gICAgaWYgKGJ1ZiBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHtcbiAgICAgIGpzb24gPSBKU09OLnBhcnNlKGJ1Zik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFzc2VydChidWYgaW5zdGFuY2VvZiBKU09OLk9iaiwgXCJhcmd1bWVudCBtdXN0IGJlIFVpbnQ4QXJyYXkgb3IgSnNvbiBPYmplY3RcIik7XG4gICAgICBqc29uID0gPEpTT04uT2JqPiBidWY7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9kZWNvZGUoanNvbik7XG4gIH1cblxuICBzdGF0aWMgZGVjb2RlKGJ1ZjogVWludDhBcnJheSk6ICR7Y2xhc3NOYW1lfSB7XG4gICAgcmV0dXJuIGRlY29kZTwke2NsYXNzTmFtZX0+KGJ1Zik7XG4gIH1cblxuICBwcml2YXRlIF9kZWNvZGUob2JqOiBKU09OLk9iaik6ICR7Y2xhc3NOYW1lfSB7XG4gICAgJHtjcmVhdGVEZWNvZGVTdGF0ZW1lbnRzKF9jbGFzcykuam9pbihcIlxcbiAgICBcIil9XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBfZW5jb2RlKG5hbWU6IHN0cmluZyB8IG51bGwgPSBcIlwiLCBfZW5jb2RlcjogSlNPTkVuY29kZXIgfCBudWxsID0gbnVsbCk6IEpTT05FbmNvZGVyIHtcbiAgICBsZXQgZW5jb2RlciA9IF9lbmNvZGVyID09IG51bGwgPyBuZXcgSlNPTkVuY29kZXIoKSA6IF9lbmNvZGVyO1xuICAgIGVuY29kZXIucHVzaE9iamVjdChuYW1lKTtcbiAgICAke2NyZWF0ZUVuY29kZVN0YXRlbWVudHMoX2NsYXNzKS5qb2luKFwiXFxuICAgIFwiKX1cbiAgICBlbmNvZGVyLnBvcE9iamVjdCgpO1xuICAgIHJldHVybiBlbmNvZGVyO1xuICB9XG4gIGVuY29kZSgpOiBVaW50OEFycmF5IHtcbiAgICByZXR1cm4gdGhpcy5fZW5jb2RlKCkuc2VyaWFsaXplKCk7XG4gIH1cblxuICBzZXJpYWxpemUoKTogVWludDhBcnJheSB7XG4gICAgcmV0dXJuIHRoaXMuZW5jb2RlKCk7XG4gIH1cblxuICB0b0pTT04oKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5fZW5jb2RlKCkudG9TdHJpbmcoKTtcbiAgfVxufWA7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdHIgPSB0b1N0cmluZyhzdG10KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzdHI7XG4gICAgfSk7XG4gICAgcmV0dXJuIHNvdXJjZVRleHQuY29uY2F0KHRoaXMuc2IpLmpvaW4oXCJcXG5cIik7XG4gIH1cbn1cbiJdfQ==