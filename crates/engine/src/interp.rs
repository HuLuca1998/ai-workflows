use std::collections::HashMap;

use serde_json::Value;

/// `${...}` 变量插值。
///
/// 命名空间三种：`input.*`（启动表单）、`run.*`（运行元数据）、
/// `节点id.端口[.路径]`（上游节点输出）。
///
/// 未解析的引用是**硬错误**。留下字面量的话，`git clone ${input.repo}`
/// 会带着一个看起来像变量的字符串跑下去，错误会出现在离原因很远的地方。

#[derive(Debug, thiserror::Error)]
pub enum InterpError {
    #[error(
        "未定义的引用 ${{{reference}}}。检查上游节点是否已产出该端口，或启动表单是否填了这个字段"
    )]
    Undefined { reference: String },
}

pub type Result<T> = std::result::Result<T, InterpError>;

pub struct Scope {
    run_id: String,
    inputs: Value,
    /// 节点输出：key 是 "节点id.端口"
    outputs: HashMap<String, Value>,
}

impl Scope {
    pub fn new(run_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            inputs: Value::Object(serde_json::Map::new()),
            outputs: HashMap::new(),
        }
    }

    pub fn set_inputs(&mut self, inputs: Value) {
        self.inputs = inputs;
    }

    pub fn set_node_output(&mut self, node_id: &str, port: &str, value: Value) {
        self.outputs.insert(format!("{node_id}.{port}"), value);
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// 摊平成环境变量。脚本里用 `$AIWF_ISSUE` 比 `${input.issue}` 自然。
    pub fn env_vars(&self) -> Vec<(String, String)> {
        let mut vars = vec![("AIWF_RUN_ID".to_string(), self.run_id.clone())];
        if let Some(map) = self.inputs.as_object() {
            for (key, value) in map {
                vars.push((format!("AIWF_{}", key.to_uppercase()), stringify(value)));
            }
        }
        vars
    }

    /// 序列化成可落盘的快照。检查点靠它跨重启保住上游输出。
    pub fn snapshot(&self) -> Value {
        serde_json::json!({
            "inputs": self.inputs,
            "outputs": self.outputs,
        })
    }

    pub fn restore(&mut self, snapshot: Value) {
        if let Some(inputs) = snapshot.get("inputs") {
            self.inputs = inputs.clone();
        }
        if let Some(outputs) = snapshot.get("outputs").and_then(Value::as_object) {
            for (key, value) in outputs {
                self.outputs.insert(key.clone(), value.clone());
            }
        }
    }

    fn lookup(&self, reference: &str) -> Option<Value> {
        let (head, rest) = reference.split_once('.')?;

        match head {
            "run" => match rest {
                "id" => Some(Value::String(self.run_id.clone())),
                _ => None,
            },
            "input" => dig(&self.inputs, rest),
            _ => {
                // 节点输出：先按 "节点.端口" 匹配，剩下的当深取路径
                let (port, path) = match rest.split_once('.') {
                    Some((port, path)) => (port, Some(path)),
                    None => (rest, None),
                };
                let value = self.outputs.get(&format!("{head}.{port}"))?;
                match path {
                    Some(path) => dig(value, path),
                    None => Some(value.clone()),
                }
            }
        }
    }
}

pub fn interpolate(template: &str, scope: &Scope) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            // 未闭合：不是引用，原样留着
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let reference = &after[..end];
        let value = scope
            .lookup(reference)
            .ok_or_else(|| InterpError::Undefined {
                reference: reference.to_string(),
            })?;
        out.push_str(&stringify(&value));
        rest = &after[end + 1..];
    }

    out.push_str(rest);
    Ok(out)
}

/// 字符串取原值（不加引号），其余序列化为 JSON。
///
/// 加引号会让 `cd ${input.repo}` 变成 `cd "/path"` —— 在 shell 里碰巧能跑，
/// 但拼进 URL 或文件名时就错了。
fn stringify(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn dig(value: &Value, path: &str) -> Option<Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current.clone())
}
