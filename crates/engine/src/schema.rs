//! JSON Schema 的一个**受限子集**：够校验节点配置，不多一分。
//!
//! 为什么不引一个 JSON Schema 库：契约生成物里实际出现的关键字只有
//! `type / properties / required / additionalProperties / propertyNames /
//! items / minItems / minLength / minimum / maximum / exclusiveMinimum /
//! enum / anyOf / default` —— 没有 `$ref`、没有 `pattern`、没有 `format`。
//! 通用库要为剩下那九成的规范付出的依赖树，换不到任何这里用得上的东西。
//!
//! 关键的一条：**错误文案必须和 TypeScript 那份逐字相同**。
//! 用户看到的那句话不该取决于他走的是配置弹层还是 MCP。
//! 对齐由 `tests/conformance_test.rs` 压着；文案的来源是
//! `packages/contracts/src/nodes/issue-text.ts` 的 `describeIssue`。

use serde_json::{Map, Value};

/// 一条不合法。`field` 是给用户看的字段名（`.describe()` 的第一行）。
#[derive(Debug, Clone)]
pub struct SchemaIssue {
    pub message: String,
}

/// 把值按 Schema 补全默认值。
///
/// 补默认值发生在校验**之前**：`.default()` 的字段缺席不算错误。
/// 而且补出来的值要落进草稿 —— 运行时行为不该取决于「谁来读这份配置」，
/// 那正是 `applyPatch` 里「固化 Schema 默认值」那一步的意思。
#[must_use]
pub fn apply_defaults(schema: &Value, value: &Value) -> Value {
    let Some(object) = schema.as_object() else {
        return value.clone();
    };

    // 值本身缺席时，先看这一层有没有默认值
    if value.is_null() {
        if let Some(default) = object.get("default") {
            return apply_defaults(schema, default);
        }
    }

    match schema_type(object) {
        Some("object") => {
            let mut out = value.as_object().cloned().unwrap_or_default();
            if let Some(props) = object.get("properties").and_then(Value::as_object) {
                for (key, sub) in props {
                    match out.get(key) {
                        Some(existing) => {
                            let filled = apply_defaults(sub, existing);
                            out.insert(key.clone(), filled);
                        }
                        None => {
                            if let Some(default) = default_of(sub) {
                                out.insert(key.clone(), default);
                            }
                        }
                    }
                }
            }
            Value::Object(out)
        }
        Some("array") => {
            let Some(items) = value.as_array() else {
                return value.clone();
            };
            let Some(item_schema) = object.get("items") else {
                return value.clone();
            };
            Value::Array(
                items
                    .iter()
                    .map(|item| apply_defaults(item_schema, item))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

/// 这个字段自己的默认值 —— 包括「对象里每个子字段各有默认值」的情形。
fn default_of(schema: &Value) -> Option<Value> {
    let object = schema.as_object()?;
    if let Some(default) = object.get("default") {
        return Some(apply_defaults(schema, default));
    }
    // 对象字段本身没写 default，但里面的子字段有 —— 这时不凭空造一个对象出来。
    // Zod 的行为是：`z.object({...})` 不 optional 就是必填，缺席即报错
    None
}

/// 校验。返回的每条都是**用户能看懂的一整句话**，顺序与 Zod 的 issue 顺序一致。
#[must_use]
pub fn validate(schema: &Value, value: &Value) -> Vec<SchemaIssue> {
    let mut issues = Vec::new();
    check(schema, schema, value, &[], &mut issues);
    issues
}

/// 路径 → 字段名。取 `.describe()` 的第一行，与 `fields.ts` 的约定一致。
///
/// 找不到就退回路径本身 —— 显示 `weird_field` 也好过显示一句英文。
fn field_name(schema: &Value, path: &[String]) -> String {
    if path.is_empty() {
        return "这一项".to_string();
    }

    let mut current = schema;
    for key in path {
        let Some(next) = descend(current, key) else {
            return path.join(".");
        };
        current = next;
    }

    current
        .get("description")
        .and_then(Value::as_str)
        .and_then(|text| text.split('\n').next())
        .filter(|line| !line.is_empty())
        .map_or_else(|| path.join("."), str::to_string)
}

/// 沿一层路径下钻。数组元素用 `items`，对象字段用 `properties`。
fn descend<'a>(schema: &'a Value, key: &str) -> Option<&'a Value> {
    let object = schema.as_object()?;
    if let Some(props) = object.get("properties").and_then(Value::as_object) {
        if let Some(found) = props.get(key) {
            return Some(found);
        }
    }
    if key.parse::<usize>().is_ok() {
        if let Some(items) = object.get("items") {
            return Some(items);
        }
    }
    // additionalProperties 形态（Record<string, string>）：值的 Schema 是同一份
    object.get("additionalProperties").filter(|v| v.is_object())
}

/// `root` 是**最外层**的 Schema，一路不变 —— 字段名要沿完整路径下钻才找得到。
/// 只传当前子 Schema 的话，`interpreter` 会显示成 `interpreter` 而不是「解释器」。
fn check(
    root: &Value,
    schema: &Value,
    value: &Value,
    path: &[String],
    issues: &mut Vec<SchemaIssue>,
) {
    let Some(object) = schema.as_object() else {
        return;
    };

    // anyOf：任何一支通过就算过。全不通过时给一句总的
    if let Some(branches) = object.get("anyOf").and_then(Value::as_array) {
        let passed = branches.iter().any(|branch| {
            let mut probe = Vec::new();
            check(root, branch, value, path, &mut probe);
            probe.is_empty()
        });
        if !passed {
            issues.push(SchemaIssue {
                message: format!("{}不符合任何一种允许的形式", name_at(root, path)),
            });
        }
        return;
    }

    if let Some(allowed) = object.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            let options: Vec<String> = allowed
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect();
            issues.push(SchemaIssue {
                message: if options.is_empty() {
                    format!("{}的取值不合法", name_at(root, path))
                } else {
                    format!("{}只能是：{}", name_at(root, path), options.join(" / "))
                },
            });
            return;
        }
    }

    let Some(expected) = schema_type(object) else {
        return;
    };

    if !type_matches(expected, value) {
        issues.push(SchemaIssue {
            message: if value.is_null() {
                format!("{}是必填项", name_at(root, path))
            } else {
                format!(
                    "{}的类型不对，应当是{}",
                    name_at(root, path),
                    type_name(expected)
                )
            },
        });
        return;
    }

    match expected {
        "string" => check_string(root, object, value, path, issues),
        "number" | "integer" => check_number(root, object, value, path, issues),
        "array" => check_array(root, object, value, path, issues),
        "object" => check_object(root, object, value, path, issues),
        _ => {}
    }
}

fn check_string(
    root: &Value,
    object: &Map<String, Value>,
    value: &Value,
    path: &[String],
    issues: &mut Vec<SchemaIssue>,
) {
    let text = value.as_str().unwrap_or_default();
    let length = text.chars().count() as i64;

    if let Some(min) = object.get("minLength").and_then(Value::as_i64) {
        if length < min {
            issues.push(SchemaIssue {
                message: if min <= 1 {
                    format!("{}不能为空", name_at(root, path))
                } else {
                    format!("{}至少需要 {min} 个字符", name_at(root, path))
                },
            });
        }
    }
    if let Some(max) = object.get("maxLength").and_then(Value::as_i64) {
        if length > max {
            issues.push(SchemaIssue {
                message: format!("{}最多 {max} 个字符", name_at(root, path)),
            });
        }
    }
}

fn check_number(
    root: &Value,
    object: &Map<String, Value>,
    value: &Value,
    path: &[String],
    issues: &mut Vec<SchemaIssue>,
) {
    let Some(number) = value.as_f64() else {
        return;
    };

    // exclusiveMinimum 在契约里表达的是 `.positive()`：Zod 报的边界是 0，
    // 文案说「不能小于 0」。这里跟着它，不自作主张说「必须大于 0」
    if let Some(min) = object.get("exclusiveMinimum").and_then(Value::as_f64) {
        if number <= min {
            issues.push(SchemaIssue {
                message: format!("{}不能小于 {}", name_at(root, path), trim_number(min)),
            });
        }
    }
    if let Some(min) = object.get("minimum").and_then(Value::as_f64) {
        if number < min {
            issues.push(SchemaIssue {
                message: format!("{}不能小于 {}", name_at(root, path), trim_number(min)),
            });
        }
    }
    if let Some(max) = object.get("maximum").and_then(Value::as_f64) {
        if number > max {
            issues.push(SchemaIssue {
                message: format!("{}不能大于 {}", name_at(root, path), trim_number(max)),
            });
        }
    }
}

fn check_array(
    root: &Value,
    object: &Map<String, Value>,
    value: &Value,
    path: &[String],
    issues: &mut Vec<SchemaIssue>,
) {
    let items = value.as_array().map(Vec::as_slice).unwrap_or_default();

    if let Some(min) = object.get("minItems").and_then(Value::as_i64) {
        if (items.len() as i64) < min {
            issues.push(SchemaIssue {
                message: if min <= 1 {
                    format!("{}至少要选一项", name_at(root, path))
                } else {
                    format!("{}至少要 {min} 项", name_at(root, path))
                },
            });
        }
    }

    if let Some(item_schema) = object.get("items") {
        for (index, item) in items.iter().enumerate() {
            let mut child = path.to_vec();
            child.push(index.to_string());
            check(root, item_schema, item, &child, issues);
        }
    }
}

fn check_object(
    root: &Value,
    object: &Map<String, Value>,
    value: &Value,
    path: &[String],
    issues: &mut Vec<SchemaIssue>,
) {
    let empty = Map::new();
    let map = value.as_object().unwrap_or(&empty);

    // 必填项先报 —— 与 Zod 的 issue 顺序一致：它按 shape 的声明顺序走，
    // 缺席的字段在自己的位置上报 invalid_type
    if let Some(props) = object.get("properties").and_then(Value::as_object) {
        let required: Vec<&str> = object
            .get("required")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        for (key, sub) in props {
            let mut child = path.to_vec();
            child.push(key.clone());

            match map.get(key) {
                Some(Value::Null) | None => {
                    // 缺席的必填项**照样往下走一层**，让子 Schema 自己说话。
                    //
                    // 直接在这里报「是必填项」会漏掉一种：枚举字段缺席时
                    // Zod 报的是 `invalid_value`，文案是「只能是：zsh / bash / sh」
                    // —— 那句话比「是必填项」有用得多，它顺带告诉用户能填什么。
                    // 走下去的话 enum 分支先命中，非枚举字段再落到类型检查
                    // （null 不匹配 string → 「是必填项」），两种都对上了
                    if required.contains(&key.as_str()) {
                        check(root, sub, &Value::Null, &child, issues);
                    }
                }
                Some(existing) => check(root, sub, existing, &child, issues),
            }
        }
    }

    // Record<string, string>：键的形状 + 值的形状
    if let Some(additional) = object.get("additionalProperties") {
        if additional.is_object() {
            let declared = object
                .get("properties")
                .and_then(Value::as_object)
                .map(|props| props.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();

            for (key, item) in map {
                if declared.contains(key) {
                    continue;
                }
                let mut child = path.to_vec();
                child.push(key.clone());
                check(root, additional, item, &child, issues);
            }
        }
    }
}

/// 字段名。单独一层是为了让上面每处调用读起来是一句话。
fn name_at(root: &Value, path: &[String]) -> String {
    field_name(root, path)
}

fn schema_type(object: &Map<String, Value>) -> Option<&str> {
    match object.get("type") {
        Some(Value::String(text)) => Some(text.as_str()),
        // `["string", "null"]` 这种取第一个非 null 的
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(Value::as_str)
            .find(|text| *text != "null"),
        _ => None,
    }
}

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn type_name(expected: &str) -> &'static str {
    match expected {
        "string" => "文本",
        "number" | "integer" => "数字",
        "boolean" => "是 / 否",
        "array" => "列表",
        "object" => "对象",
        _ => "未知类型",
    }
}

/// `900000.0` 要显示成 `900000`：JavaScript 那边的数字没有小数点尾巴。
fn trim_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}
