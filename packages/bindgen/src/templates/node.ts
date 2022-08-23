////////////////////////////////////////////////////////////////////////////
//
// Copyright 2022 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////
import { strict as assert } from "assert";

import { TemplateContext } from "../context";
import {
  CppVar,
  CppFunc,
  CppFuncProps,
  CppMemInit,
  CppCtor,
  CppMethod,
  CppClass,
  CppDecls,
  CppCtorProps,
} from "../cpp";
import { bindModel, BoundSpec, Type } from "../bound-model";

import "../js-passes";

// Code assumes this is a unique name that is always in scope to refer to the Napi::Env.
// Callbacks need to ensure this is in scope. Functions taking Env arguments must use this name.
const env = "napi_env_var_ForBindGen";

const node_callback_info = new CppVar("const Napi::CallbackInfo&", "info");
const envFromCbInfo = `auto ${env} = info.Env();\n`;

function tryWrap(body: string) {
  return `try {
                ${body}
            } catch (const std::exception& ex) {
                throwNodeException(${env}, ex);
            }
        `;
}

class CppNodeMethod extends CppMethod {
  constructor(private addon: NodeAddon, name: string, props?: CppFuncProps) {
    super(name, "Napi::Value", [node_callback_info], props);
  }

  definition() {
    return super.definition(`
            ${envFromCbInfo}
            const auto callBlock = ${this.addon.get()}->startCall();
            ${tryWrap(this.body)}
        `);
  }
}

class CppNodeCtor extends CppCtor {
  constructor(name: string, props?: CppCtorProps) {
    super(name, [node_callback_info], props);
  }

  definition() {
    // Note: if we ever want need to try to catch failing member inits, need to
    // change CppCtor to support function-try blocks.
    return super.definition(`
            ${envFromCbInfo}
            ${tryWrap(this.body)}
        `);
  }
}

function pushRet<T, U extends T>(arr: T[], elem: U) {
  arr.push(elem);
  return elem;
}

class NodeAddon extends CppClass {
  inits: string[] = [];
  exports: Record<string, string> = {};

  constructor() {
    super("RealmAddon");
    this.withCrtpBase("Napi::Addon");

    this.members.push(new CppVar("std::deque<std::string>", "m_string_bufs"));
    this.addMethod(
      new CppMethod("wrapString", "const std::string&", [new CppVar("std::string", "str")], {
        attributes: "inline",
        body: `return m_string_bufs.emplace_back(std::move(str));`,
      }),
    );
    this.addMethod(
      new CppMethod("startCall", "auto", [], {
        attributes: "inline",
        body: `return ContainerResizer(m_string_bufs);`,
      }),
    );

    const injectables = ["Float", "UUID", "ObjectId", "Decimal128"];
    injectables.forEach((t) => this.members.push(new CppVar("Napi::FunctionReference", NodeAddon.memberNameFor(t))));
    this.addMethod(
      new CppMethod("injectInjectables", "void", [node_callback_info], {
        body: `
          auto ctors = info[0].As<Napi::Object>();
          ${injectables
            .map((t) => `${NodeAddon.memberNameFor(t)} = Napi::Persistent(ctors.Get("${t}").As<Napi::Function>());`)
            .join("\n")}
        `,
      }),
    );
  }

  generateMembers() {
    this.addMethod(
      new CppCtor(this.name, [new CppVar("Napi::Env", env), new CppVar("Napi::Object", "exports")], {
        body: `
            ${this.inits.join("\n")}

            DefineAddon(exports, {
                ${Object.entries(this.exports)
                  .map(([name, val]) => `InstanceValue(${name}, ${val}.Value(), napi_enumerable),`)
                  .join("\n")}
                InstanceMethod<&${this.name}::injectInjectables>("injectInjectables"),
            });
            `,
      }),
    );
  }

  addClass(cls: NodeObjectWrap) {
    const mem = NodeAddon.memberNameFor(cls);
    this.members.push(new CppVar("Napi::FunctionReference", mem));
    this.inits.push(`${mem} = Persistent(${cls.name}::makeCtor(${env}));`);
    this.exports[`${cls.name}::jsName`] = mem;
  }

  static memberNameFor(cls: string | NodeObjectWrap) {
    if (typeof cls != "string") cls = cls.jsName;
    return `m_cls_${cls}_ctor`;
  }

  accessCtor(cls: string | NodeObjectWrap) {
    return `${this.get()}->${NodeAddon.memberNameFor(cls)}`;
  }

  get() {
    return `${env}.GetInstanceData<${this.name}>()`;
  }
}

class NodeObjectWrap extends CppClass {
  ctor: CppCtor;
  constructor(public jsName: string) {
    super(`Node_${jsName}`);
    this.withCrtpBase("Napi::ObjectWrap");

    this.ctor = this.addMethod(
      new CppNodeCtor(this.name, {
        mem_inits: [new CppMemInit(this.bases[0], "info")],
      }),
    );

    this.members.push(new CppVar("constexpr const char*", "jsName", { value: `"${jsName}"`, static: true }));
  }
}

/**
 * Converts a Type object to its spelling in C++, eg to be used to declare an argument or template parameter.
 *
 * TODO, consider moving this to live on the Type classes themselves.
 */
function toCpp(type: Type): string {
  switch (type.kind) {
    case "Pointer":
      return `${toCpp(type.type)}*`;
    case "Opaque":
      return type.name;
    case "Const":
      return `${toCpp(type.type)} const`;
    case "Ref":
      return `${toCpp(type.type)}&`;
    case "RRef":
      return `${toCpp(type.type)}&&`;
    case "Template":
      return `${type.name}<${type.args.map(toCpp).join(", ")}>`;

    case "Struct":
    case "Enum":
    case "Class":
      return type.cppName;

    case "Primitive":
      const primitiveMap: Record<string, string> = {
        count_t: "size_t",
      };
      return primitiveMap[type.name] ?? type.name;

    case "Func":
      // We currently just produce a lambda which has an unutterable type.
      // We could make a UniqueFunction for the type, but we may want to
      // use other types instead, such as std::function in some cases.
      // This will be more important when implementing interfaces.
      assert.fail("Cannot convert function types to Cpp type names");
      break;

    default:
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}

function convertPrimToNode(addon: NodeAddon, type: string, expr: string): string {
  switch (type) {
    case "void":
      return `((void)(${expr}), ${env}.Undefined())`;

    case "bool":
      return `Napi::Boolean::New(${env}, ${expr})`;

    case "float":
      return `${addon.accessCtor("Float")}.New({${convertPrimToNode(addon, "double", expr)}})`;

    case "count_t":
    case "double":
    case "int":
    case "int32_t":
      return `Napi::Number::New(${env}, ${expr})`;

    case "int64_t":
    case "uint64_t":
      return `Napi::BigInt::New(${env}, ${expr})`;

    case "std::string_view":
    case "std::string":
      return `([&] (auto&& sd) {
                return Napi::String::New(${env}, sd.data(), sd.size());
            }(${expr}))`;

    case "StringData":
      return `([&] (StringData sd) {
                return Napi::String::New(${env}, sd.data(), sd.size());
            }(${expr}))`;

    case "OwnedBinaryData":
      return convertPrimToNode(addon, "BinaryData", `${expr}.get()`);

    case "BinaryData":
      return `([&] (BinaryData bd) -> Napi::Value {
                auto arr = Napi::ArrayBuffer::New(${env}, bd.size());
                memcpy(arr.Data(), bd.data(), bd.size());
                return arr;
            }(${expr}))`;
    case "Mixed":
      return `NODE_FROM_MIXED(${env}, ${expr})`;

    case "ObjectId":
    case "UUID":
    case "Decimal128":
      return `${addon.accessCtor(type)}.New({${convertPrimToNode(addon, "std::string", `${expr}.to_string()`)}})`;
  }
  assert.fail(`unexpected primitive type '${type}'`);
}
function convertPrimFromNode(addon: NodeAddon, type: string, expr: string): string {
  // TODO consider using coercion using ToString, ToNumber, ToBoolean.
  switch (type) {
    case "void":
      return `((void)(${expr}))`;

    case "bool":
      return `(${expr}).As<Napi::Boolean>().Value()`;

    case "double":
      return `(${expr}).As<Napi::Number>().DoubleValue()`;
    case "float":
      return `(${expr}).As<Napi::Object>().Get("value").As<Napi::Number>().FloatValue()`;

    case "int":
    case "int32_t":
      return `(${expr}).As<Napi::Number>().Int32Value()`;

    case "count_t":
      // TODO consider calling Int32Value on 32-bit platforms. Probably not worth it though.
      return `(${expr}).As<Napi::Number>().Int64Value()`;

    case "int64_t":
      return `extractInt64FromNode(${expr})`;
    case "uint64_t":
      return `extractUint64FromNode(${expr})`;

    case "std::string":
      return `(${expr}).As<Napi::String>().Utf8Value()`;

    case "StringData":
    case "std::string_view":
      // TODO look into not wrapping if directly converting into an argument.
      return `${addon.get()}->wrapString(${convertPrimFromNode(addon, "std::string", expr)})`;

    case "OwnedBinaryData":
    case "BinaryData":
      return `([&] (const Napi::Value& v) -> ${type} {
                auto buf = v.As<Napi::ArrayBuffer>();
                return BinaryData(static_cast<const char*>(buf.Data()), buf.ByteLength());
            })(${expr})`;
    case "Mixed":
      return `NODE_TO_MIXED(${env}, ${expr})`;

    case "UUID":
    case "Decimal128":
      return `${type}(${convertPrimFromNode(addon, "std::string", `${expr}.ToString()`)})`;

    // TODO add a StringData overload to the ObjectId ctor in core so this can merge with above.
    case "ObjectId":
      return `${type}(${convertPrimFromNode(addon, "std::string", `${expr}.ToString()`)}.c_str())`;
  }
  assert.fail(`unexpected primitive type '${type}'`);
}

function convertToNode(addon: NodeAddon, type: Type, expr: string): string {
  const c = convertToNode.bind(null, addon); // shortcut for recursion
  switch (type.kind) {
    case "Primitive":
      return convertPrimToNode(addon, type.name, expr);
    case "Pointer":
      return `[&](auto* ptr){ return ptr ? ${c(type.type, "*ptr")}: ${env}.Null(); } (${expr})`;

    case "Opaque":
      return `Napi::External<${type.name}>::New(${env}, &${expr})`;

    case "Const":
    case "Ref":
    case "RRef": // Note: not explicitly taking advantage of moveability yet. TODO?
      return c(type.type, expr);

    case "Template":
      // Most templates only take a single argument so do this here.
      const inner = type.args[0];
      switch (type.name) {
        case "std::shared_ptr":
          if (inner.kind == "Class" && inner.sharedPtrWrapped) return `NODE_FROM_SHARED_${inner.name}(${env}, ${expr})`;
          return c(inner, `*${expr}`);
        case "util::Optional":
          return `[&] (auto&& opt) { return !opt ? ${env}.Null() : ${c(inner, "*opt")}; }(${expr})`;
        case "std::vector":
          // TODO try different ways to create the array to see what is fastest.
          // eg, try calling push() with and without passing size argument to New().
          return `[&] (auto&& vec) {
                        auto out = Napi::Array::New(${env}, vec.size());
                        uint32_t i = 0;
                        for (auto&& e : vec) {
                            out[i++] = ${c(inner, "e")};
                        }
                        return out;
                    }(${expr})`;
        case "std::pair":
        case "std::tuple":
          return `
            [&] (auto&& tup) {
                auto out = Napi::Array::New(${env}, ${type.args.length});
                ${type.args.map((arg, i) => `out[${i}u] = ${c(arg, `std::get<${i}>(tup)`)};`).join("\n")}
                return out;
            }(${expr})`;
      }
      assert.fail(`unknown template ${type.name}`);
      break;

    case "Class":
      assert(!type.sharedPtrWrapped, `should not directly convert from ${type.name} without shared_ptr wrapper`);
      return `NODE_FROM_CLASS_${type.name}(${env}, ${expr})`;

    case "Struct":
      return `NODE_FROM_STRUCT_${type.name}(${env}, ${expr})`;

    case "Func":
      // TODO: see if we want to try to propagate a function name in rather than always making them anonymous.
      return `
            [&] (auto&& cb) -> Napi::Value {
                if constexpr(std::is_constructible_v<bool, decltype(cb)>) {
                    if (!bool(cb)) {
                        return ${env}.Null();
                    }
                }
                return Napi::Function::New(${env}, [cb] (const Napi::CallbackInfo& info) {
                    auto ${env} = info.Env();
                    const auto callBlock = ${addon.get()}->startCall();
                    ${tryWrap(`
                        return ${c(
                          type.ret,
                          `cb(
                            ${type.args.map((arg, i) => convertFromNode(addon, arg.type, `info[${i}]`)).join(", ")}
                        )`,
                        )};
                    `)}
                });
            }(${expr})`;

    case "Enum":
      return `[&]{
                static_assert(sizeof(${type.cppName}) <= sizeof(int32_t), "we only support enums up to 32 bits");
                return Napi::Number::New(${env}, int(${expr}));
            }()`;

    default:
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}
function convertFromNode(addon: NodeAddon, type: Type, expr: string): string {
  const c = convertFromNode.bind(null, addon); // shortcut for recursion
  switch (type.kind) {
    case "Primitive":
      return convertPrimFromNode(addon, type.name, expr);
    case "Pointer":
      return `[&] (Napi::Value v) { return (v.IsNull() || v.IsUndefined()) ? nullptr : &${c(
        type.type,
        "v",
      )}; }(${expr})`;
    case "Opaque":
      return `*((${expr}).As<Napi::External<${type.name}>>().Data())`;

    case "Const":
    case "Ref":
      return c(type.type, expr);

    case "RRef":
      // For now, copying. TODO Consider moving instead, although we may want a marker in JS code.
      return `REALM_DECAY_COPY(${c(type.type, expr)})`;

    case "Template":
      // Most templates only take a single argument so do this here.
      const inner = type.args[0];

      switch (type.name) {
        case "std::shared_ptr":
          if (inner.kind == "Class" && inner.sharedPtrWrapped) return `NODE_TO_SHARED_${inner.name}(${expr})`;
          return c(inner, `*${expr}`);
        case "util::Optional":
          return `[&] (Napi::Value val) {
                        using Opt = util::Optional<${toCpp(inner)}>;
                        return (val.IsNull() || val.IsUndefined()) ? Opt() : Opt(${c(inner, "val")});
                    }(${expr})`;
        case "std::vector":
          return `[&] (const Napi::Array vec) {
                auto out = std::vector<${toCpp(inner)}>();

                const uint32_t length = vec.Length();
                out.reserve(length);
                for (uint32_t i = 0; i < length; i++) {
                    out.push_back(${c(inner, "vec[i]")});
                }
                return out;
            }((${expr}).As<Napi::Array>())`;
        case "std::tuple":
        case "std::pair":
          const suffix = type.name.split(":")[2];
          const nArgs = type.args.length;
          return `[&] (const Napi::Array& arr) {
              if (arr.Length() != ${nArgs}u)
                throw Napi::TypeError::New(${env}, "Need an array with exactly ${nArgs} elements");
              return std::make_${suffix}(${type.args.map((arg, i) => c(arg, `arr[${i}u]`))});
          }((${expr}).As<Napi::Array>())`;
      }
      assert.fail(`unknown template ${type.name}`);
      break;

    case "Class":
      if (type.sharedPtrWrapped) return `*NODE_TO_SHARED_${type.name}(${expr})`;
      return `NODE_TO_CLASS_${type.name}(${expr})`;

    case "Struct":
      return `NODE_TO_STRUCT_${type.name}(${expr})`;

    case "Func":
      // TODO see if we ever need to do any conversion from Napi::Error exceptions to something else.
      // TODO need to handle null/undefined here. A bit tricky since we don't know the real type in the YAML.
      // TODO need to consider different kinds of functions:
      // - functions called inline (or otherwise called from within a JS context)
      // - async functions called from JS thread (need to use MakeCallback() rather than call) (current impl)
      // - async functions called from other thread that don't need to wait for JS to return
      // - async functions called from other thread that must wait for JS to return (anything with non-void return)
      //     - This has a risk of deadlock if not done correctly.
      // Note: putting the FunctionReference in a shared_ptr because some of these need to be put into a std::function
      // which requires copyability, but FunctionReferences are move-only.
      return `
                [cb = std::make_shared<Napi::FunctionReference>(Napi::Persistent(${expr}.As<Napi::Function>()))]
                (${type.args.map(({ name, type }) => `${toCpp(type)} ${name}`).join(", ")}) -> ${toCpp(type.ret)} {
                    auto ${env} = cb->Env();
                    Napi::HandleScope hs(${env});
                    try {
                        return ${c(
                          type.ret,
                          `cb->MakeCallback(
                              ${env}.Global(),
                              {${type.args.map(({ name, type }) => convertToNode(addon, type, name)).join(", ")}
                        })`,
                        )};
                    } catch (Napi::Error& e) {
                        // Populate the cache of the message now to ensure it is safe for any C++ code to call what().
                        (void)e.what();
                        throw;
                    }
                }`;

    case "Enum":
      return `${type.cppName}((${expr}).As<Napi::Number>().DoubleValue())`;

    default:
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}

class NodeCppDecls extends CppDecls {
  inits: string[] = [];
  addon = pushRet(this.classes, new NodeAddon());
  constructor(spec: BoundSpec) {
    super();

    for (const struct of spec.records) {
      const fieldsFrom = [];
      const fieldsTo = [];
      for (const field of struct.fields) {
        const cppFieldName = field.name;
        fieldsFrom.push(`out.Set("${field.jsName}", ${convertToNode(this.addon, field.type, `in.${cppFieldName}`)});`);
        // TODO: consider doing lazy conversion of some types to JS, only if the field is accessed.
        fieldsTo.push(`{
                    auto field = obj.Get("${field.jsName}");
                    if (!field.IsUndefined()) {
                        out.${cppFieldName} = ${convertFromNode(this.addon, field.type, "field")};
                    } else if constexpr (${field.required ? "true" : "false"}) {
                        throw Napi::TypeError::New(${env}, "${struct.name}::${field.jsName} is required");
                    }
                }`);
      }

      this.free_funcs.push(
        new CppFunc(
          `NODE_FROM_STRUCT_${struct.name}`,
          "Napi::Value",
          [new CppVar("Napi::Env", env), new CppVar(struct.cppName, "in")],
          {
            attributes: "[[maybe_unused]]", // TODO look into generating these functions on demand instead.
            body: `
                auto out = Napi::Object::New(${env});
                ${fieldsFrom.join("")}
                return out;
            `,
          },
        ),
      );
      this.free_funcs.push(
        new CppFunc(`NODE_TO_STRUCT_${struct.name}`, struct.cppName, [new CppVar("Napi::Value", "val")], {
          attributes: "[[maybe_unused]]",
          body: `
              auto ${env} = val.Env();
              if (!val.IsObject())
                  throw Napi::TypeError::New(${env}, "expected an object");
              auto obj = val.As<Napi::Object>();
              auto out = ${struct.cppName}();
              ${fieldsTo.join("")}
              return out;
          `,
        }),
      );
    }
    for (const specClass of spec.classes) {
      // TODO need to do extra work to enable JS implementation of interfaces
      const cls = pushRet(this.classes, new NodeObjectWrap(specClass.jsName));
      const descriptors: string[] = [];
      const self = specClass.needsDeref ? "(*m_val)" : "(m_val)";

      for (const method of specClass.methods) {
        const cppMeth = cls.addMethod(new CppNodeMethod(this.addon, method.jsName, { static: method.isStatic }));
        descriptors.push(
          `${method.isStatic ? "Static" : "Instance"}Method<&${cppMeth.qualName()}>("${method.jsName}")`,
        );

        const args = method.sig.args.map((a, i) => convertFromNode(this.addon, a.type, `info[${i}]`));

        cppMeth.body += `
            if (info.Length() != ${args.length})
                throw Napi::TypeError::New(${env}, "expected ${args.length} arguments");
            return ${convertToNode(this.addon, method.sig.ret, method.call({ self }, ...args))};
        `;
      }

      if (specClass.iterable) {
        const cppMeth = cls.addMethod(new CppNodeMethod(this.addon, "Symbol_iterator"));
        descriptors.push(`InstanceMethod<&${cppMeth.qualName()}>(Napi::Symbol::WellKnown(${env}, "iterator"))`);
        cppMeth.body += `
            if (info.Length() != 0)
                throw Napi::TypeError::New(${env}, "expected 0 arguments");

            auto jsIt = Napi::Object::New(${env});
            jsIt.Set("_keepAlive", info.This());
            jsIt.Set("next", Napi::Function::New(napi_env_var_ForBindGen,
                [it = ${self}.begin(), end = ${self}.end()] (const Napi::CallbackInfo& info) mutable {
                    const auto ${env} = info.Env();

                    auto ret = Napi::Object::New(${env});
                    if (it == end) {
                        ret.Set("done", Napi::Boolean::New(${env}, true));
                    } else {
                        ret.Set("value", ${convertToNode(this.addon, specClass.iterable, "*it")});
                        ++it;
                    }
                    return ret;
                }));

            return jsIt;
        `;
      }

      for (const prop of specClass.properties) {
        const cppMeth = cls.addMethod(new CppNodeMethod(this.addon, prop.jsName));
        cppMeth.body += `return ${convertToNode(this.addon, prop.type, `${self}.${prop.name}()`)};`;
        descriptors.push(`InstanceAccessor<&${cppMeth.qualName()}>("${prop.jsName}")`);
      }

      cls.ctor.body += `
            if (info.Length() != 1 || !info[0].IsExternal())
                throw Napi::TypeError::New(${env}, "need 1 external argument");
        `;

      const valueType = specClass.sharedPtrWrapped ? `std::shared_ptr<${specClass.cppName}>` : specClass.cppName;
      const refType = specClass.sharedPtrWrapped ? `const ${valueType}&` : `${valueType}&`;
      const kind = specClass.sharedPtrWrapped ? "SHARED" : "CLASS";

      cls.members.push(new CppVar(valueType, "m_val"));
      cls.ctor.body += `m_val = std::move(*info[0].As<Napi::External<${valueType}>>().Data());`;
      // TODO in napi 8 we can use type_tags to validate that the object REALLY is from us.
      this.free_funcs.push(
        new CppFunc(`NODE_TO_${kind}_${specClass.name}`, refType, [new CppVar("Napi::Value", "val")], {
          attributes: "[[maybe_unused]]",
          body: `
            auto ${env} = val.Env();
            auto obj = val.ToObject();
            if (!obj.InstanceOf(${this.addon.accessCtor(cls)}.Value()))
                throw Napi::TypeError::New(${env}, "Expected a ${cls.jsName}");
            return ${cls.name}::Unwrap(obj)->m_val;
          `,
        }),
      );

      this.free_funcs.push(
        new CppFunc(
          `NODE_FROM_${kind}_${specClass.name}`,
          "Napi::Value",
          [new CppVar("Napi::Env", env), new CppVar(valueType, "val")],
          {
            attributes: "[[maybe_unused]]",
            body: `return ${this.addon.accessCtor(cls)}.New({Napi::External<${valueType}>::New(${env}, &val)});`,
          },
        ),
      );

      cls.addMethod(
        new CppMethod("makeCtor", "Napi::Function", [new CppVar("Napi::Env", env)], {
          static: true,
          body: `return DefineClass(${env}, "${specClass.jsName}", { ${descriptors.map((d) => d + ",").join("\n")} });`,
        }),
      );

      this.addon.addClass(cls);
    }

    this.free_funcs.push(
      new CppFunc("NODE_FROM_MIXED", "Napi::Value", [new CppVar("Napi::Env", env), new CppVar("Mixed", "val")], {
        body: `
          if (val.is_null())
              return ${env}.Null();
          switch (val.get_type()) {
          ${spec.mixedInfo.getters
            .map(
              (g) => `
                case DataType::Type::${g.dataType}:
                  return ${convertToNode(this.addon, g.type, `val.${g.getter}()`)};
              `,
            )
            .join("\n")}
          // The remaining cases are never stored in a Mixed.
          ${spec.mixedInfo.unusedDataTypes.map((t) => `case DataType::Type::${t}: break;`).join("\n")}
          }
          REALM_UNREACHABLE();
        `,
      }),
      new CppFunc("NODE_TO_MIXED", "Mixed", [new CppVar("Napi::Env", env), new CppVar("Napi::Value", "val")], {
        body: `
          switch(val.Type()) {
          case napi_null:
              return Mixed();
          case napi_string:
              return ${convertFromNode(this.addon, spec.types["StringData"], "val")};
          case napi_number:
              return ${convertFromNode(this.addon, spec.types["double"], "val")};
          case napi_bigint:
              return ${convertFromNode(this.addon, spec.types["int64_t"], "val")};
          case napi_boolean:
              return ${convertFromNode(this.addon, spec.types["bool"], "val")};
          case napi_object: {
              const auto obj = val.As<Napi::Object>();
              const auto addon = ${this.addon.get()};
              if (val.IsArrayBuffer()) {
                return ${convertFromNode(this.addon, spec.types["BinaryData"], "val")};
              } ${
                // This list should be sorted in in roughly the expected frequency since earlier entries will be faster.
                [
                  ["Obj", "Obj"],
                  ["Timestamp", "Timestamp"],
                  ["float", "Float"],
                  ["ObjLink", "ObjLink"],
                  ["ObjectId", "ObjectId"],
                  ["Decimal128", "Decimal128"],
                  ["UUID", "UUID"],
                ]
                  .map(
                    ([typeName, jsName]) =>
                      `else if (obj.InstanceOf(addon->${NodeAddon.memberNameFor(jsName)}.Value())) {
                          return ${convertFromNode(this.addon, spec.types[typeName], "val")};
                      }`,
                  )
                  .join(" ")
              }

              // TODO should we check for "boxed" values like 'new Number(1)'?

              const auto ctorName = obj.Get("constructor").As<Napi::Object>().Get("name").As<Napi::String>().Utf8Value();
              throw Napi::TypeError::New(${env}, "Unable to convert an object with ctor '" + ctorName + "' to a Mixed");
          }
          // TODO consider treating undefined as null
          ${["undefined", "symbol", "function", "external"]
            .map((t) => `case napi_${t}: throw Napi::TypeError::New(${env}, "Can't convert ${t} to Mixed");`)
            .join("\n")}
          }
          REALM_UNREACHABLE();
        `,
      }),
    );

    this.addon.generateMembers();
  }

  outputDefsTo(out: (...parts: string[]) => void) {
    super.outputDefsTo(out);
    out(`\nNODE_API_NAMED_ADDON(realm_cpp, ${this.addon.name})`);
  }
}

export function generateNode({ spec, file: makeFile }: TemplateContext): void {
  const out = makeFile("node_init.cpp", "clang-format");

  // HEADER
  out(`// This file is generated: Update the spec instead of editing this file directly`);

  for (const header of spec.headers) {
    out(`#include <${header}>`);
  }

  out(`
      #include <napi.h>

      // Used by Helpers::get_keypath_mapping
      #include <realm/object-store/keypath_helpers.hpp>

      namespace realm::js::node {
      namespace {

      // TODO move to header or realm-core
      struct Helpers {
          static TableRef get_table(const SharedRealm& realm, StringData name) {
              return realm->read_group().get_table(name);
          }
          static TableRef get_table(const SharedRealm& realm, TableKey key) {
              return realm->read_group().get_table(key);
          }
          static query_parser::KeyPathMapping get_keypath_mapping(const SharedRealm& realm) {
              query_parser::KeyPathMapping mapping;
              populate_keypath_mapping(mapping, *realm);
              return mapping;
          }
          static Results results_from_query(const SharedRealm& realm, Query q) {
              auto ordering = q.get_ordering();
              return Results(realm, std::move(q), ordering ? *ordering : DescriptorOrdering());
          }
          static std::shared_ptr<_impl::ObjectNotifier> make_object_notifier(const SharedRealm& realm, const Obj& obj) {
              realm->verify_thread();
              realm->verify_notifications_available();
              auto notifier = std::make_shared<_impl::ObjectNotifier>(realm, obj.get_table()->get_key(), obj.get_key());
              _impl::RealmCoordinator::register_notifier(notifier);
              return notifier;
          }
      };

      struct ObjectChangeSet {
          ObjectChangeSet() = default;
          /*implicit*/ ObjectChangeSet(const CollectionChangeSet& changes) {
              is_deleted = !changes.deletions.empty();
              for (const auto& [col_key_val, index_set] : changes.columns) {
                  changed_columns.push_back(ColKey(col_key_val));
              }
          }

          bool is_deleted;
          std::vector<ColKey> changed_columns;
      };

      ////////////////////////////////////////////////////////////

      // These helpers are used by the generated code.
      // TODO Consider moving them to a header.

      template <typename Container>
      class [[nodiscard]] ContainerResizer {
      public:
          explicit ContainerResizer(Container& container) : m_container(&container), m_old_size(container.size()) {}
          ContainerResizer(ContainerResizer&&) = delete;
          ~ContainerResizer() {
              if (m_old_size == 0) {
                  // this can be a bit faster than resize()
                  m_container->clear();
              } else {
                  m_container->resize(m_old_size);
              }
          }
      private:
          Container* const m_container;
          const size_t m_old_size;
      };

      // TODO consider allowing Number (double) with (u)int64_t.
      int64_t extractInt64FromNode(const Napi::Value& input) {
          bool lossless;
          auto output = input.As<Napi::BigInt>().Int64Value(&lossless);
          if (!lossless)
              throw Napi::RangeError::New(input.Env(), "Value doesn't fit in int64_t");
          return output;
      }
      uint64_t extractUint64FromNode(const Napi::Value& input) {
          bool lossless;
          auto output = input.As<Napi::BigInt>().Uint64Value(&lossless);
          if (!lossless)
              throw Napi::RangeError::New(input.Env(), "Value doesn't fit in uint64_t");
          return output;
      }

      [[noreturn]] REALM_NOINLINE void throwNodeException(Napi::Env& ${env}, const std::exception& e) {
          if (dynamic_cast<const Napi::Error*>(&e))
              throw; // Just allow exception propagation to continue
          // TODO consider throwing more specific errors in some cases.
          // TODO consider using ThrowAsJavaScriptException instead here.
          throw Napi::Error::New(${env}, e.what());
      }

      // Equivalent to auto(x) in c++23.
      #define REALM_DECAY_COPY(x) std::decay_t<decltype(x)>(x)

      ////////////////////////////////////////////////////////////
    `);

  new NodeCppDecls(bindModel(spec)).outputDefsTo(out);

  out(`
        } // namespace
        } // namespace realm::js::node
    `);
}