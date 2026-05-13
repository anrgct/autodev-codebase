好的！基于 `demo/model.py` 的全文内容，我拟了以下几组**问题-位置-片段**三元组，覆盖了不同维度的代码知识。你可以用这些来测试你的分段向量搜索效果：

---

### Q1: 模型初始化时如何处理不同的模型来源（本地文件、HUB、Triton）？

| 字段     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| **位置** | `demo/model.py#L118-141`                                     |
| **片段** | `__init__` 方法中 `is_hub_model` / `is_triton_model` 判断 + `.yaml` / `.pt` 分支加载 |

```demo/model.py#L118-141
if self.is_hub_model(model):
    checks.check_requirements("hub-sdk>=0.0.12")
    session = HUBTrainingSession.create_session(model)
    model = session.model_file
    if session.train_args:
        self.session = session
elif self.is_triton_model(model):
    self.model_name = self.model = model
    return
if Path(model).suffix in {".yaml", ".yml"}:
    self._new(model, task=task, verbose=verbose)
else:
    self._load(model, task=task)
```

---

### Q2: 如何判断一个模型字符串是 Triton Server URL？

| 字段     | 内容                       |
| -------- | -------------------------- |
| **位置** | `demo/model.py#L157-174`   |
| **片段** | `is_triton_model` 静态方法 |

```demo/model.py#L157-174
@staticmethod
def is_triton_model(model: str) -> bool:
    from urllib.parse import urlsplit
    url = urlsplit(model)
    return url.netloc and url.path and url.scheme in {"http", "grpc"}
```

---

### Q3: predict 方法在 stream 模式和 CLI 模式下分别调用哪个底层方法？

| 字段     | 内容                         |
| -------- | ---------------------------- |
| **位置** | `demo/model.py#L318-322`     |
| **片段** | `predict` 方法末尾的分支逻辑 |

```demo/model.py#L318-322
return self.predictor.predict_cli(source=source) if is_cli else self.predictor(source=source, stream=stream)
```

---

### Q4: 训练完成后如何更新模型权重和配置？

| 字段     | 内容                                         |
| -------- | -------------------------------------------- |
| **位置** | `demo/model.py#L479-484`                     |
| **片段** | `train` 方法末尾，RANK 为 -1 或 0 时的后处理 |

```demo/model.py#L479-484
if RANK in {-1, 0}:
    ckpt = self.trainer.best if self.trainer.best.exists() else self.trainer.last
    self.model, _ = attempt_load_one_weight(ckpt)
    self.overrides = self.model.args
    self.metrics = getattr(self.trainer.validator, "metrics", None)
```

---

### Q5: 模型导出支持的参数有哪些？

| 字段     | 内容                      |
| -------- | ------------------------- |
| **位置** | `demo/model.py#L416-424`  |
| **片段** | `export` 方法的 Args 文档 |

```demo/model.py#L416-424
format (str): Export format (e.g., 'onnx', 'engine', 'coreml').
half (bool): Export model in half-precision.
int8 (bool): Export model in int8 precision.
device (str): Device to run the export on.
workspace (int): Maximum memory workspace size for TensorRT engines.
nms (bool): Add Non-Maximum Suppression (NMS) module to model.
simplify (bool): Simplify ONNX model.
```

---

### Q6: 超参数调优支持哪两种模式？

| 字段     | 内容                               |
| -------- | ---------------------------------- |
| **位置** | `demo/model.py#L503-518`           |
| **片段** | `tune` 方法根据 `use_ray` 标志分支 |

```demo/model.py#L503-518
def tune(self, use_ray=False, iterations=10, *args, **kwargs):
    self._check_is_pytorch_model()
    if use_ray:
        from ultralytics.utils.tuner import run_ray_tune
        return run_ray_tune(self, max_samples=iterations, *args, **kwargs)
    else:
        from .tuner import Tuner
        custom = {}
        args = {**self.overrides, **custom, **kwargs, "mode": "train"}
        return Tuner(args=args, _callbacks=self.callbacks)(model=self, iterations=iterations)
```

---

### Q7: save 方法保存模型时包含了哪些额外元数据？

| 字段     | 内容                           |
| -------- | ------------------------------ |
| **位置** | `demo/model.py#L218-228`       |
| **片段** | `save` 方法中的 `updates` 字典 |

```demo/model.py#L218-228
updates = {
    "model": deepcopy(self.model).half() if isinstance(self.model, nn.Module) else self.model,
    "date": datetime.now().isoformat(),
    "version": __version__,
    "license": "AGPL-3.0 License (https://ultralytics.com/license)",
    "docs": "https://docs.ultralytics.com",
}
torch.save({**self.ckpt, **updates}, filename)
```

---

### Q8: 从 checkpoint 加载模型时保留哪些参数？

| 字段     | 内容                        |
| -------- | --------------------------- |
| **位置** | `demo/model.py#L643-650`    |
| **片段** | `_reset_ckpt_args` 静态方法 |

```demo/model.py#L643-650
@staticmethod
def _reset_ckpt_args(args: dict) -> dict:
    include = {"imgsz", "data", "task", "single_cls"}
    return {k: v for k, v in args.items() if k in include}
```

---

### Q9: 如何通过回调机制扩展模型行为？

| 字段     | 内容                                                       |
| -------- | ---------------------------------------------------------- |
| **位置** | `demo/model.py#L589-615`                                   |
| **片段** | `add_callback`/`clear_callback`/`reset_callbacks` 三个方法 |

```demo/model.py#L589-615
def add_callback(self, event: str, func) -> None:
    self.callbacks[event].append(func)

def clear_callback(self, event: str) -> None:
    self.callbacks[event] = []

def reset_callbacks(self) -> None:
    for event in callbacks.default_callbacks.keys():
        self.callbacks[event] = [callbacks.default_callbacks[event][0]]
```

---

### Q10: embed 方法默认从哪一层提取特征向量？

| 字段     | 内容                         |
| -------- | ---------------------------- |
| **位置** | `demo/model.py#L275-279`     |
| **片段** | `embed` 方法中 kwargs 默认值 |

```demo/model.py#L275-279
def embed(self, ...):
    if not kwargs.get("embed"):
        kwargs["embed"] = [len(self.model.model) - 2]
    return self.predict(source, stream, **kwargs)
```

---

### Q11: 跟踪（track）和预测（predict）的主要区别在哪？

| 字段     | 内容                                          |
| -------- | --------------------------------------------- |
| **位置** | `demo/model.py#L341-347`                      |
| **片段** | `track` 方法中注册跟踪器 + 设置较低置信度阈值 |

```demo/model.py#L341-347
if not hasattr(self.predictor, "trackers"):
    from ultralytics.trackers import register_tracker
    register_tracker(self, persist)
kwargs["conf"] = kwargs.get("conf") or 0.1
kwargs["batch"] = kwargs.get("batch") or 1
kwargs["mode"] = "track"
```

---

### Q12: _smart_load 如何根据 task 动态加载对应的模块？

| 字段     | 内容                         |
| -------- | ---------------------------- |
| **位置** | `demo/model.py#L665-683`     |
| **片段** | `_smart_load` 方法的完整实现 |

```demo/model.py#L665-683
def _smart_load(self, key: str):
    try:
        return self.task_map[self.task][key]
    except Exception as e:
        name = self.__class__.__name__
        mode = inspect.stack()[1][3]
        raise NotImplementedError(
            emojis(f"WARNING ⚠️ '{name}' model does not support '{mode}' mode for '{self.task}' task yet.")
        ) from e
```

---

以上 12 组 Q-A 对覆盖了：

- **初始化流程** (Q1)  
- **静态工具方法** (Q2, Q8)  
- **核心预测流程** (Q3, Q11)  
- **模型生命周期** (Q4, Q5, Q7)  
- **调优与扩展** (Q6, Q9, Q12)  
- **特征提取** (Q10)  

每个片段长度适中（3～15 行），适合用来评测分段向量搜索的召回精度。

---

# 测试结果
```
╭─   ~/w/autodev-codebase on   master ⇡3 *4  took  5s  base
╰─❯ ./src/examples/eval_search.py
```

## gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf

╭─   ~/w/autodev-codebase on   master ⇡6 *4 !4
╰─❯ ./src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✗  未命中  (2.4s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.5220  (2.4s)
  [3/12] predict_cli vs predictor() 分支 ... ✗  未命中  (2.4s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✗  未命中  (2.4s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✗  未命中  (2.4s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #17  score=0.3600  (2.4s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #7  score=0.4220  (2.4s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #13  score=0.4160  (2.4s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✗  未命中  (2.4s)
  [10/12] embed 默认取倒数第二层 ... ✗  未命中  (2.4s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✗  未命中  (2.4s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #13  score=0.4420  (2.4s)

====================================================================================================
  单项结果明细
====================================================================================================
    #  查询描述                             命中       排名       分数 Top-结果
  ------------------------------------------------------------------------------------------------
    1  初始化时 HUB/Triton/本地文件判断分支         ✗         -        -  [0.499, 0.485, 0.484, 0.484, 0.484]
    2  is_triton_model 静态方法             ✓        #1   0.5220  [0.522, 0.496, 0.475, 0.453, 0.439]
    3  predict_cli vs predictor() 分支    ✗         -        -  [0.430, 0.426, 0.418, 0.407, 0.400]
    4  train 末尾用 best/last 权重更新模型       ✗         -        -  [0.525, 0.521, 0.520, 0.516, 0.514]
    5  export 文档中的 format/half/int8 等参数   ✗         -        -  [0.534, 0.527, 0.522, 0.519, 0.493]
    6  tune 方法: use_ray vs Tuner 分支     ✓       #17   0.3600  [0.458, 0.439, 0.426, 0.426, 0.423]
    7  保存模型时的 license/version/docs 信息   ✓        #7   0.4220  [0.474, 0.453, 0.446, 0.434, 0.432]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓       #13   0.4160  [0.487, 0.463, 0.462, 0.462, 0.461]
    9  add_callback/clear_callback/reset_callbacks   ✗         -        -  [0.508, 0.497, 0.487, 0.482, 0.480]
   10  embed 默认取倒数第二层                   ✗         -        -  [0.470, 0.458, 0.449, 0.441, 0.433]
   11  track 注册跟踪器、低置信度阈值               ✗         -        -  [0.393, 0.374, 0.371, 0.369, 0.367]
   12  通过 task_map 动态加载 model/trainer 等   ✓       #13   0.4420  [0.503, 0.480, 0.471, 0.471, 0.470]

====================================================================================================
  聚合指标
====================================================================================================
  总用例数:          12
  命中数:            5 / 12  (41.7%)
  未命中数:          7

  Recall@1:            8.3%  (1 个)
  Recall@3:            8.3%  (1 个)
  Recall@5:            8.3%  (1 个)
  Recall@10:          16.7%  (2 个)
  Recall@20:          41.7%  (5 个)

  MRR (Mean Reciprocal Rank):  0.1130
  目标平均分数:                0.4324
  命中结果中位数排名:          13

====================================================================================================
  未命中用例详情
====================================================================================================
  #1 [模型初始化时如何处理不同的模型来源]
      期望: code_kw='is_hub_model', hierarchy='__init__'
      Top-3 最高分: 0.4990, 0.4850, 0.4840

  #3 [进行模型推理时，流式输出和命令行输出走的不同路径]
      期望: code_kw='predict_cli', hierarchy='predict'
      Top-3 最高分: 0.4300, 0.4260, 0.4180

  #4 [训练完成后更新模型权重]
      期望: code_kw='attempt_load_one_weight', hierarchy='train'
      Top-3 最高分: 0.5250, 0.5210, 0.5200

  #5 [模型导出成不同格式时支持哪些配置选项]
      期望: code_kw='export format', hierarchy='export'
      Top-3 最高分: 0.5340, 0.5270, 0.5220

  #9 [如何为模型注册自定义事件处理函数]
      期望: code_kw='add_callback', hierarchy='add_callback'
      Top-3 最高分: 0.5080, 0.4970, 0.4870

  #10 [提取特征向量时默认使用哪一层的输出]
      期望: code_kw='len(self.model.model)', hierarchy='embed'
      Top-3 最高分: 0.4700, 0.4580, 0.4490

  #11 [目标跟踪和普通预测推理在实现上有哪些不同]
      期望: code_kw='register_tracker', hierarchy='track'
      Top-3 最高分: 0.3930, 0.3740, 0.3710
      
## hf.co/lmstudio-community/embeddinggemma-300m-qat-GGUF

╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #4  score=0.4910  (1.1s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.5960  (1.0s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #9  score=0.4230  (1.0s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #5  score=0.4220  (1.1s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.5800  (1.1s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.4170  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #2  score=0.4900  (1.0s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.5600  (1.1s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.5900  (1.0s)
  [10/12] embed 默认取倒数第二层 ... ✓  #4  score=0.4340  (1.0s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #1  score=0.4470  (1.0s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.4960  (1.1s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #4   0.4910  [0.520, 0.513, 0.500, 0.491, 0.483]
    2  is_triton_model 静态方法             ✓        #1   0.5960  [0.596, 0.570, 0.482, 0.464, 0.459]
    3  predict_cli vs predictor() 分支    ✓        #9   0.4230  [0.482, 0.460, 0.458, 0.447, 0.445]
    4  train 末尾用 best/last 权重更新模型       ✓        #5   0.4220  [0.473, 0.463, 0.456, 0.428, 0.422]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.5800  [0.580, 0.493, 0.471, 0.456, 0.449]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.4170  [0.417, 0.400, 0.390, 0.372, 0.368]
    7  保存模型时的 license/version/docs 信息   ✓        #2   0.4900  [0.503, 0.490, 0.471, 0.458, 0.427]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.5600  [0.560, 0.459, 0.404, 0.389, 0.380]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.5900  [0.590, 0.546, 0.510, 0.496, 0.487]

   10  embed 默认取倒数第二层                   ✓        #4   0.4340  [0.456, 0.450, 0.443, 0.434, 0.434]
   11  track 注册跟踪器、低置信度阈值               ✓        #1   0.4470  [0.447, 0.391, 0.380, 0.353, 0.352]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.4960  [0.496, 0.484, 0.425, 0.421, 0.405]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:           58.3%  (7 个)
  Recall@3:           66.7%  (8 个)
  Recall@5:           91.7%  (11 个)
  Recall@10:         100.0%  (12 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  0.6926
  目标平均分数:                0.4955
  命中结果中位数排名:          1

## hf.co/mradermacher/F2LLM-v2-80M-GGUF:f16

╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #5  score=0.3400  (1.0s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.3590  (1.0s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #3  score=0.3400  (1.0s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #2  score=0.4530  (1.0s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.4670  (1.0s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.3900  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.4320  (1.0s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.3880  (1.0s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.5520  (1.0s)
  [10/12] embed 默认取倒数第二层 ... ✗  未命中  (1.0s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #1  score=0.3710  (1.0s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.4350  (1.0s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #5   0.3400  [0.396, 0.370, 0.350, 0.341, 0.340]
    2  is_triton_model 静态方法             ✓        #1   0.3590  [0.359, 0.296, 0.280, 0.278, 0.256]
    3  predict_cli vs predictor() 分支    ✓        #3   0.3400  [0.357, 0.343, 0.340, 0.336, 0.299]
    4  train 末尾用 best/last 权重更新模型       ✓        #2   0.4530  [0.505, 0.453, 0.368, 0.359, 0.341]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.4670  [0.467, 0.430, 0.374, 0.358, 0.327]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.3900  [0.390, 0.336, 0.282, 0.273, 0.247]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.4320  [0.432, 0.387, 0.275, 0.260, 0.255]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.3880  [0.388, 0.369, 0.278, 0.208, 0.206]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.5520  [0.552, 0.429, 0.427, 0.349, 0.310]

   10  embed 默认取倒数第二层                   ✗         -        -  [0.204, 0.185, 0.174, 0.153, 0.148]
   11  track 注册跟踪器、低置信度阈值               ✓        #1   0.3710  [0.371, 0.358, 0.269, 0.265, 0.255]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.4350  [0.435, 0.354, 0.290, 0.252, 0.227]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            11 / 12  (91.7%)
  未命中数:          1

  Recall@1:           66.7%  (8 个)
  Recall@3:           83.3%  (10 个)
  Recall@5:           91.7%  (11 个)
  Recall@10:          91.7%  (11 个)
  Recall@20:          91.7%  (11 个)

  MRR (Mean Reciprocal Rank):  0.7528
  目标平均分数:                0.4115
  命中结果中位数排名:          1

====================================================================================================

  未命中用例详情
====================================================================================================

  #10 [提取特征向量时默认使用哪一层的输出]
      期望: code_kw='len(self.model.model)', hierarchy='embed'
      Top-3 最高分: 0.2040, 0.1850, 0.1740

## hf.co/mradermacher/F2LLM-v2-160M-GGUF:iq4_xs

╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #9  score=0.2910  (1.1s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.3850  (1.0s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.3430  (1.0s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.5160  (1.1s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.3960  (1.0s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.3810  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.3740  (1.0s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.3900  (1.0s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.5630  (1.0s)
  [10/12] embed 默认取倒数第二层 ... ✓  #19  score=0.1180  (1.0s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #2  score=0.3130  (1.0s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.4330  (1.0s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #9   0.2910  [0.325, 0.323, 0.321, 0.316, 0.312]
    2  is_triton_model 静态方法             ✓        #1   0.3850  [0.385, 0.354, 0.331, 0.313, 0.297]
    3  predict_cli vs predictor() 分支    ✓        #1   0.3430  [0.343, 0.333, 0.317, 0.279, 0.264]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.5160  [0.516, 0.463, 0.354, 0.336, 0.328]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.3960  [0.396, 0.321, 0.309, 0.281, 0.270]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.3810  [0.381, 0.344, 0.344, 0.327, 0.318]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.3740  [0.374, 0.320, 0.266, 0.256, 0.253]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.3900  [0.390, 0.365, 0.273, 0.252, 0.224]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.5630  [0.563, 0.500, 0.427, 0.374, 0.370]

   10  embed 默认取倒数第二层                   ✓       #19   0.1180  [0.234, 0.186, 0.183, 0.180, 0.176]
   11  track 注册跟踪器、低置信度阈值               ✓        #2   0.3130  [0.339, 0.313, 0.255, 0.248, 0.202]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.4330  [0.433, 0.362, 0.343, 0.260, 0.241]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:           75.0%  (9 个)
  Recall@3:           83.3%  (10 个)
  Recall@5:           83.3%  (10 个)
  Recall@10:          91.7%  (11 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  0.8053
  目标平均分数:                0.3753
  命中结果中位数排名:          1

## hf.co/mradermacher/F2LLM-v2-330M-GGUF:iq4_xs

╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #1  score=0.3990  (1.1s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.4640  (1.1s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.4200  (1.0s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.5190  (1.0s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.5150  (1.0s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.4030  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.4040  (1.0s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.4410  (1.1s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.5970  (1.0s)
  [10/12] embed 默认取倒数第二层 ... ✗  未命中  (1.0s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #2  score=0.3580  (1.0s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.4660  (1.0s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #1   0.3990  [0.399, 0.398, 0.376, 0.376, 0.370]
    2  is_triton_model 静态方法             ✓        #1   0.4640  [0.464, 0.398, 0.391, 0.383, 0.383]
    3  predict_cli vs predictor() 分支    ✓        #1   0.4200  [0.420, 0.407, 0.405, 0.357, 0.344]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.5190  [0.519, 0.452, 0.449, 0.417, 0.397]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.5150  [0.515, 0.386, 0.357, 0.357, 0.344]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.4030  [0.403, 0.381, 0.372, 0.362, 0.345]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.4040  [0.404, 0.351, 0.348, 0.326, 0.317]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.4410  [0.441, 0.347, 0.322, 0.228, 0.227]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.5970  [0.597, 0.495, 0.491, 0.442, 0.396]

   10  embed 默认取倒数第二层                   ✗         -        -  [0.292, 0.280, 0.257, 0.248, 0.238]
   11  track 注册跟踪器、低置信度阈值               ✓        #2   0.3580  [0.421, 0.358, 0.340, 0.318, 0.315]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.4660  [0.466, 0.375, 0.318, 0.315, 0.307]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            11 / 12  (91.7%)
  未命中数:          1

  Recall@1:           83.3%  (10 个)
  Recall@3:           91.7%  (11 个)
  Recall@5:           91.7%  (11 个)
  Recall@10:          91.7%  (11 个)
  Recall@20:          91.7%  (11 个)

  MRR (Mean Reciprocal Rank):  0.8750
  目标平均分数:                0.4533
  命中结果中位数排名:          1

====================================================================================================

  未命中用例详情
====================================================================================================

  #10 [提取特征向量时默认使用哪一层的输出]
      期望: code_kw='len(self.model.model)', hierarchy='embed'
      Top-3 最高分: 0.2920, 0.2800, 0.2570

## hf.co/mradermacher/F2LLM-v2-0.6B-GGUF:iq4_xs



╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #1  score=0.6660  (1.0s)
  [2/12] is_triton_model 静态方法 ... ✓  #3  score=0.6410  (1.0s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.6690  (1.0s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.7170  (1.1s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.6870  (1.1s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.6430  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.7000  (1.0s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.6820  (1.0s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.7590  (1.0s)
  [10/12] embed 默认取倒数第二层 ... ✓  #11  score=0.5210  (1.1s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #3  score=0.5820  (1.1s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.6730  (1.0s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #1   0.6660  [0.666, 0.655, 0.651, 0.645, 0.640]
    2  is_triton_model 静态方法             ✓        #3   0.6410  [0.673, 0.645, 0.641, 0.630, 0.625]
    3  predict_cli vs predictor() 分支    ✓        #1   0.6690  [0.669, 0.616, 0.613, 0.605, 0.598]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.7170  [0.717, 0.673, 0.626, 0.620, 0.611]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.6870  [0.687, 0.608, 0.581, 0.572, 0.569]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.6430  [0.643, 0.608, 0.594, 0.589, 0.582]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.7000  [0.700, 0.645, 0.642, 0.616, 0.614]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.6820  [0.682, 0.648, 0.612, 0.577, 0.575]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.7590  [0.759, 0.664, 0.646, 0.638, 0.607]

   10  embed 默认取倒数第二层                   ✓       #11   0.5210  [0.560, 0.556, 0.551, 0.550, 0.547]
   11  track 注册跟踪器、低置信度阈值               ✓        #3   0.5820  [0.631, 0.587, 0.582, 0.560, 0.553]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.6730  [0.673, 0.609, 0.580, 0.580, 0.572]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:           75.0%  (9 个)
  Recall@3:           91.7%  (11 个)
  Recall@5:           91.7%  (11 个)
  Recall@10:          91.7%  (11 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  0.8131
  目标平均分数:                0.6617
  命中结果中位数排名:          1

## hf.co/mradermacher/F2LLM-v2-1.7B-GGUF:iq4_xs

╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #2  score=0.8310  (1.0s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.8080  (1.0s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.7940  (1.1s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.8210  (1.1s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.8550  (1.0s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.7940  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.8300  (1.1s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.8370  (1.0s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.8550  (1.0s)
  [10/12] embed 默认取倒数第二层 ... ✓  #5  score=0.7190  (1.1s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #1  score=0.7760  (1.2s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.8070  (1.1s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #2   0.8310  [0.832, 0.831, 0.812, 0.808, 0.806]
    2  is_triton_model 静态方法             ✓        #1   0.8080  [0.808, 0.784, 0.779, 0.772, 0.770]
    3  predict_cli vs predictor() 分支    ✓        #1   0.7940  [0.794, 0.782, 0.779, 0.763, 0.762]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.8210  [0.821, 0.784, 0.773, 0.768, 0.767]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.8550  [0.855, 0.835, 0.794, 0.788, 0.764]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.7940  [0.794, 0.741, 0.738, 0.738, 0.731]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.8300  [0.830, 0.797, 0.773, 0.764, 0.763]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.8370  [0.837, 0.769, 0.753, 0.749, 0.737]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.8550  [0.855, 0.804, 0.785, 0.770, 0.764]

   10  embed 默认取倒数第二层                   ✓        #5   0.7190  [0.731, 0.731, 0.725, 0.723, 0.719]
   11  track 注册跟踪器、低置信度阈值               ✓        #1   0.7760  [0.776, 0.762, 0.744, 0.741, 0.737]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.8070  [0.807, 0.794, 0.776, 0.745, 0.743]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:           83.3%  (10 个)
  Recall@3:           91.7%  (11 个)
  Recall@5:          100.0%  (12 个)
  Recall@10:         100.0%  (12 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  0.8917
  目标平均分数:                0.8106
  命中结果中位数排名:          1

## qwen3-embedding:0.6b:q8_0

╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #1  score=0.5650  (1.1s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.6790  (1.0s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #5  score=0.5020  (1.1s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.5550  (1.0s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.6080  (1.0s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.6110  (1.1s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.5060  (1.1s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.6940  (1.0s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.6390  (1.0s)
  [10/12] embed 默认取倒数第二层 ... ✓  #2  score=0.4210  (1.0s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #2  score=0.5290  (1.0s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.6300  (1.0s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #1   0.5650  [0.565, 0.541, 0.516, 0.509, 0.505]
    2  is_triton_model 静态方法             ✓        #1   0.6790  [0.679, 0.672, 0.590, 0.528, 0.523]
    3  predict_cli vs predictor() 分支    ✓        #5   0.5020  [0.526, 0.515, 0.510, 0.505, 0.502]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.5550  [0.555, 0.534, 0.528, 0.524, 0.517]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.6080  [0.608, 0.544, 0.460, 0.450, 0.439]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.6110  [0.611, 0.454, 0.444, 0.437, 0.421]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.5060  [0.506, 0.468, 0.401, 0.396, 0.376]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.6940  [0.694, 0.544, 0.536, 0.471, 0.419]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.6390  [0.639, 0.531, 0.520, 0.500, 0.412]

   10  embed 默认取倒数第二层                   ✓        #2   0.4210  [0.435, 0.421, 0.399, 0.396, 0.375]
   11  track 注册跟踪器、低置信度阈值               ✓        #2   0.5290  [0.546, 0.529, 0.518, 0.510, 0.452]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.6300  [0.630, 0.558, 0.452, 0.428, 0.388]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:           75.0%  (9 个)
  Recall@3:           91.7%  (11 个)
  Recall@5:          100.0%  (12 个)
  Recall@10:         100.0%  (12 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  0.8500
  目标平均分数:                0.5783
  命中结果中位数排名:          1



## qwen3-embedding:4b:q4_k_m

╭─   ~/w/autodev-codebase on   master *4 !4 ?4
╰─❯ python3 src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #1  score=0.5890  (1.2s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.6850  (1.1s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.5540  (1.1s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.5420  (1.1s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.6640  (1.1s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.5790  (1.1s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.5970  (1.1s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.6340  (1.1s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.7030  (1.2s)
  [10/12] embed 默认取倒数第二层 ... ✓  #1  score=0.4540  (1.1s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #1  score=0.5800  (1.1s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.5460  (1.2s)

====================================================================================================

  单项结果明细
====================================================================================================

    #  查询描述                             命中       排名       分数 Top-结果

------------------------------------------------------------------------------------------------

    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #1   0.5890  [0.589, 0.553, 0.526, 0.519, 0.498]
    2  is_triton_model 静态方法             ✓        #1   0.6850  [0.685, 0.640, 0.524, 0.486, 0.474]
    3  predict_cli vs predictor() 分支    ✓        #1   0.5540  [0.554, 0.485, 0.481, 0.472, 0.463]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.5420  [0.542, 0.538, 0.537, 0.511, 0.494]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.6640  [0.664, 0.545, 0.454, 0.449, 0.449]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.5790  [0.579, 0.348, 0.346, 0.345, 0.341]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.5970  [0.597, 0.473, 0.456, 0.452, 0.436]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.6340  [0.634, 0.515, 0.486, 0.450, 0.412]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.7030  [0.703, 0.533, 0.529, 0.514, 0.440]

   10  embed 默认取倒数第二层                   ✓        #1   0.4540  [0.454, 0.406, 0.398, 0.357, 0.345]
   11  track 注册跟踪器、低置信度阈值               ✓        #1   0.5800  [0.580, 0.567, 0.491, 0.481, 0.459]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.5460  [0.546, 0.508, 0.381, 0.380, 0.337]

====================================================================================================

  聚合指标
====================================================================================================

  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:          100.0%  (12 个)
  Recall@3:          100.0%  (12 个)
  Recall@5:          100.0%  (12 个)
  Recall@10:         100.0%  (12 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  1.0000
  目标平均分数:                0.5939
  命中结果中位数排名:          1

## jina-embeddings-v5-nano-mlx

```
  // jina-grep-cli的jina服务
  "embedderProvider": "jina",
  "embedderModelId": "jina-embeddings-v5-nano",
  "embedderJinaApiKey": "test",
  "embedderJinaBaseUrl": "http://localhost:8089/v1",
```
╭─   ~/w/autodev-codebase on   master *4 !12 ?6
╰─❯ ./src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #1  score=0.4950  (0.9s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.5230  (1.0s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.4240  (0.9s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.5360  (0.9s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.6440  (1.0s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.4270  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.4590  (0.9s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.5120  (0.9s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.6270  (0.9s)
  [10/12] embed 默认取倒数第二层 ... ✓  #1  score=0.3150  (0.9s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #1  score=0.4460  (0.9s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.4640  (0.8s)

====================================================================================================
  单项结果明细
====================================================================================================
    #  查询描述                             命中       排名       分数 Top-结果
  ------------------------------------------------------------------------------------------------
    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #1   0.4950  [0.495, 0.487, 0.477, 0.438, 0.431]
    2  is_triton_model 静态方法             ✓        #1   0.5230  [0.523, 0.517, 0.413, 0.406, 0.381]
    3  predict_cli vs predictor() 分支    ✓        #1   0.4240  [0.424, 0.403, 0.389, 0.365, 0.358]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.5360  [0.536, 0.526, 0.519, 0.516, 0.424]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.6440  [0.644, 0.406, 0.352, 0.352, 0.347]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.4270  [0.427, 0.342, 0.311, 0.288, 0.281]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.4590  [0.459, 0.427, 0.382, 0.364, 0.359]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.5120  [0.512, 0.466, 0.421, 0.391, 0.385]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.6270  [0.627, 0.526, 0.522, 0.457, 0.415]
   10  embed 默认取倒数第二层                   ✓        #1   0.3150  [0.315, 0.312, 0.300, 0.297, 0.297]
   11  track 注册跟踪器、低置信度阈值               ✓        #1   0.4460  [0.446, 0.410, 0.338, 0.325, 0.317]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.4640  [0.464, 0.416, 0.328, 0.291, 0.266]

====================================================================================================
  聚合指标
====================================================================================================
  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:          100.0%  (12 个)
  Recall@3:          100.0%  (12 个)
  Recall@5:          100.0%  (12 个)
  Recall@10:         100.0%  (12 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  1.0000
  目标平均分数:                0.4893
  命中结果中位数排名:          1

# /Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-F16.gguf

```
  // // --- LlamaCPP (纯本地嵌入) ---
  // "embedderProvider": "llamacpp",
  // "embedderLlamaCppModelPath": "/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-F16.gguf",
```
╭─   ~/w/autodev-codebase on   feature/llamacpp-auto-dimension *4 !22 ?6
╰─❯ ./src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #1  score=0.5470  (1.4s)
  [2/12] is_triton_model 静态方法 ... ✗  未命中  (1.9s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.4130  (1.9s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.3280  (1.9s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #3  score=0.1290  (1.4s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #2  score=0.3570  (1.4s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.5360  (1.9s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✗  未命中  (1.4s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.2990  (1.4s)
  [10/12] embed 默认取倒数第二层 ... ✓  #2  score=0.3310  (1.4s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #1  score=0.4530  (1.4s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.3310  (1.4s)

====================================================================================================
  单项结果明细
====================================================================================================
    #  查询描述                             命中       排名       分数 Top-结果
  ------------------------------------------------------------------------------------------------
    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #1   0.5470  [0.547, 0.496, 0.472, 0.462, 0.459]
    2  is_triton_model 静态方法             ✗         -        -  [0.470]
    3  predict_cli vs predictor() 分支    ✓        #1   0.4130  [0.413, 0.401, 0.361, 0.360, 0.346]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.3280  [0.328, 0.315, 0.298, 0.261, 0.253]
    5  export 文档中的 format/half/int8 等参数   ✓        #3   0.1290  [0.377, 0.140, 0.129, 0.127, 0.125]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #2   0.3570  [0.369, 0.357, 0.296, 0.291, 0.291]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.5360  [0.536, 0.495, 0.461, 0.458, 0.434]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✗         -        -  [0.556, 0.144, 0.126, 0.125, 0.121]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.2990  [0.299, 0.297, 0.296, 0.286, 0.272]
   10  embed 默认取倒数第二层                   ✓        #2   0.3310  [0.337, 0.331, 0.314, 0.312, 0.307]
   11  track 注册跟踪器、低置信度阈值               ✓        #1   0.4530  [0.453, 0.446, 0.373, 0.365, 0.321]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.3310  [0.331, 0.319, 0.234, 0.225, 0.222]

====================================================================================================
  聚合指标
====================================================================================================
  总用例数:          12
  命中数:            10 / 12  (83.3%)
  未命中数:          2

  Recall@1:           58.3%  (7 个)
  Recall@3:           83.3%  (10 个)
  Recall@5:           83.3%  (10 个)
  Recall@10:          83.3%  (10 个)
  Recall@20:          83.3%  (10 个)

  MRR (Mean Reciprocal Rank):  0.6944
  目标平均分数:                0.3724
  命中结果中位数排名:          1

====================================================================================================
  未命中用例详情
====================================================================================================
  #2 [如何判断一个模型字符串指向远程推理服务]
      期望: code_kw='def is_triton_model', hierarchy='class Model'
      Top-3 最高分: 0.4700

  #8 [加载 checkpoint 时保留哪些参数]
      期望: code_kw='def _reset_ckpt_args', hierarchy='class Model'
      Top-3 最高分: 0.5560, 0.1440, 0.1260
      
## jina-embeddings-v5-small-mlx
╭─   ~/w/autodev-codebase on   master *4 !12 ?6      base
╰─❯ ./src/examples/eval_search.py

╔══════════════════════════════════════════════════════════════════════════════╗
║  语义搜索召回率评估                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  搜索命令:   npx tsx src/cli.ts
  工作区:     demo (autodev-codebase/demo)
  测试用例数: 12
  每查询结果: Top-20

  [1/12] 初始化时 HUB/Triton/本地文件判断分支 ... ✓  #1  score=0.4490  (0.9s)
  [2/12] is_triton_model 静态方法 ... ✓  #1  score=0.4990  (0.9s)
  [3/12] predict_cli vs predictor() 分支 ... ✓  #1  score=0.4480  (1.0s)
  [4/12] train 末尾用 best/last 权重更新模型 ... ✓  #1  score=0.5390  (0.9s)
  [5/12] export 文档中的 format/half/int8 等参数 ... ✓  #1  score=0.5980  (1.0s)
  [6/12] tune 方法: use_ray vs Tuner 分支 ... ✓  #1  score=0.4490  (1.0s)
  [7/12] 保存模型时的 license/version/docs 信息 ... ✓  #1  score=0.5130  (1.1s)
  [8/12] _reset_ckpt_args 保留 imgsz/data/task ... ✓  #1  score=0.5280  (0.9s)
  [9/12] add_callback/clear_callback/reset_callbacks ... ✓  #1  score=0.6080  (0.9s)
  [10/12] embed 默认取倒数第二层 ... ✓  #3  score=0.2920  (0.9s)
  [11/12] track 注册跟踪器、低置信度阈值 ... ✓  #1  score=0.4560  (0.9s)
  [12/12] 通过 task_map 动态加载 model/trainer 等 ... ✓  #1  score=0.5040  (1.0s)

====================================================================================================
  单项结果明细
====================================================================================================
    #  查询描述                             命中       排名       分数 Top-结果
  ------------------------------------------------------------------------------------------------
    1  初始化时 HUB/Triton/本地文件判断分支         ✓        #1   0.4490  [0.449, 0.423, 0.409, 0.401, 0.383]
    2  is_triton_model 静态方法             ✓        #1   0.4990  [0.499, 0.473, 0.362, 0.354, 0.349]
    3  predict_cli vs predictor() 分支    ✓        #1   0.4480  [0.448, 0.361, 0.359, 0.354, 0.347]
    4  train 末尾用 best/last 权重更新模型       ✓        #1   0.5390  [0.539, 0.497, 0.465, 0.463, 0.434]
    5  export 文档中的 format/half/int8 等参数   ✓        #1   0.5980  [0.598, 0.442, 0.373, 0.370, 0.369]
    6  tune 方法: use_ray vs Tuner 分支     ✓        #1   0.4490  [0.449, 0.325, 0.312, 0.312, 0.308]
    7  保存模型时的 license/version/docs 信息   ✓        #1   0.5130  [0.513, 0.367, 0.355, 0.343, 0.336]
    8  _reset_ckpt_args 保留 imgsz/data/task   ✓        #1   0.5280  [0.528, 0.494, 0.444, 0.419, 0.409]
    9  add_callback/clear_callback/reset_callbacks   ✓        #1   0.6080  [0.608, 0.523, 0.509, 0.427, 0.391]
   10  embed 默认取倒数第二层                   ✓        #3   0.2920  [0.296, 0.295, 0.292, 0.273, 0.261]
   11  track 注册跟踪器、低置信度阈值               ✓        #1   0.4560  [0.456, 0.398, 0.389, 0.378, 0.324]
   12  通过 task_map 动态加载 model/trainer 等   ✓        #1   0.5040  [0.504, 0.457, 0.382, 0.318, 0.318]

====================================================================================================
  聚合指标
====================================================================================================
  总用例数:          12
  命中数:            12 / 12  (100.0%)
  未命中数:          0

  Recall@1:           91.7%  (11 个)
  Recall@3:          100.0%  (12 个)
  Recall@5:          100.0%  (12 个)
  Recall@10:         100.0%  (12 个)
  Recall@20:         100.0%  (12 个)

  MRR (Mean Reciprocal Rank):  0.9444
  目标平均分数:                0.4903
  命中结果中位数排名:          1

## 📊 所有测试结果汇总

### 一、逐模型命中总览

| # | 模型 | 命中率 | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|------|--------|----------|----------|----------|-----|
| 1 | `embeddinggemma-300m` | **100%** (12/12) | 58.3% | 66.7% | 91.7% | 0.6926 |
| 2 | `F2LLM-80M:f16` | **91.7%** (11/12) | 66.7% | 83.3% | 91.7% | 0.7528 |
| 3 | `F2LLM-160M:iq4_xs` | **100%** (12/12) | 75.0% | 83.3% | 83.3% | 0.8053 |
| 4 | `F2LLM-330M:iq4_xs` | **91.7%** (11/12) | 83.3% | 91.7% | 91.7% | 0.8750 |
| 5 | `F2LLM-0.6B:iq4_xs` | **100%** (12/12) | 75.0% | 91.7% | 91.7% | 0.8131 |
| 6 | `F2LLM-1.7B:iq4_xs` | **100%** (12/12) | 83.3% | 91.7% | **100%** | 0.8917 |
| 7 | `qwen3-embedding:0.6b:q8_0` | **100%** (12/12) | 75.0% | 91.7% | **100%** | 0.8500 |
| 8 | `qwen3-embedding:4b:q4_k_m` | **100%** (12/12) | **100%** | **100%** | **100%** | **1.0000** |
| 9 | `jina-embeddings-v5-nano-mlx` | **100%** (12/12) | **100%** | **100%** | **100%** | **1.0000** |
| 10 | `jina-embeddings-v5-small-mlx` | **100%** (12/12) | 91.7% | **100%** | **100%** | 0.9444 |

---

### 二、逐用例命中明细

#### 用例 #1 — 初始化时 HUB/Triton/本地文件判断分支

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #4 | 0.4910 |
| F2LLM-80M | ✓ | #5 | 0.3400 |
| F2LLM-160M | ✓ | #9 | 0.2910 |
| F2LLM-330M | ✓ | #1 | 0.3990 |
| F2LLM-0.6B | ✓ | #1 | 0.6660 |
| F2LLM-1.7B | ✓ | #2 | 0.8310 |
| qwen3-0.6b | ✓ | #1 | 0.5650 |
| qwen3-4b | ✓ | #1 | 0.5890 |
| jina-nano-mlx | ✓ | #1 | 0.4950 |
| jina-small-mlx | ✓ | #1 | 0.4490 |

#### 用例 #2 — is_triton_model 静态方法

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #1 | 0.5960 |
| F2LLM-80M | ✓ | #1 | 0.3590 |
| F2LLM-160M | ✓ | #1 | 0.3850 |
| F2LLM-330M | ✓ | #1 | 0.4640 |
| F2LLM-0.6B | ✓ | #3 | 0.6410 |
| F2LLM-1.7B | ✓ | #1 | 0.8080 |
| qwen3-0.6b | ✓ | #1 | 0.6790 |
| qwen3-4b | ✓ | #1 | 0.6850 |
| jina-nano-mlx | ✓ | #1 | 0.5230 |
| jina-small-mlx | ✓ | #1 | 0.4990 |

#### 用例 #3 — predict_cli vs predictor() 分支

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #9 | 0.4230 |
| F2LLM-80M | ✓ | #3 | 0.3400 |
| F2LLM-160M | ✓ | #1 | 0.3430 |
| F2LLM-330M | ✓ | #1 | 0.4200 |
| F2LLM-0.6B | ✓ | #1 | 0.6690 |
| F2LLM-1.7B | ✓ | #1 | 0.7940 |
| qwen3-0.6b | ✓ | #5 | 0.5020 |
| qwen3-4b | ✓ | #1 | 0.5540 |
| jina-nano-mlx | ✓ | #1 | 0.4240 |
| jina-small-mlx | ✓ | #1 | 0.4480 |

#### 用例 #4 — train 末尾用 best/last 权重更新模型

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #5 | 0.4220 |
| F2LLM-80M | ✓ | #2 | 0.4530 |
| F2LLM-160M | ✓ | #1 | 0.5160 |
| F2LLM-330M | ✓ | #1 | 0.5190 |
| F2LLM-0.6B | ✓ | #1 | 0.7170 |
| F2LLM-1.7B | ✓ | #1 | 0.8210 |
| qwen3-0.6b | ✓ | #1 | 0.5550 |
| qwen3-4b | ✓ | #1 | 0.5420 |
| jina-nano-mlx | ✓ | #1 | 0.5360 |
| jina-small-mlx | ✓ | #1 | 0.5390 |

#### 用例 #5 — export 文档中的 format/half/int8 等参数

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #1 | 0.5800 |
| F2LLM-80M | ✓ | #1 | 0.4670 |
| F2LLM-160M | ✓ | #1 | 0.3960 |
| F2LLM-330M | ✓ | #1 | 0.5150 |
| F2LLM-0.6B | ✓ | #1 | 0.6870 |
| F2LLM-1.7B | ✓ | #1 | **0.8550** |
| qwen3-0.6b | ✓ | #1 | 0.6080 |
| qwen3-4b | ✓ | #1 | 0.6640 |
| jina-nano-mlx | ✓ | #1 | 0.6440 |
| jina-small-mlx | ✓ | #1 | 0.5980 |

#### 用例 #6 — tune 方法: use_ray vs Tuner 分支

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #1 | 0.4170 |
| F2LLM-80M | ✓ | #1 | 0.3900 |
| F2LLM-160M | ✓ | #1 | 0.3810 |
| F2LLM-330M | ✓ | #1 | 0.4030 |
| F2LLM-0.6B | ✓ | #1 | 0.6430 |
| F2LLM-1.7B | ✓ | #1 | 0.7940 |
| qwen3-0.6b | ✓ | #1 | 0.6110 |
| qwen3-4b | ✓ | #1 | 0.5790 |
| jina-nano-mlx | ✓ | #1 | 0.4270 |
| jina-small-mlx | ✓ | #1 | 0.4490 |

#### 用例 #7 — 保存模型时的 license/version/docs 信息

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #2 | 0.4900 |
| F2LLM-80M | ✓ | #1 | 0.4320 |
| F2LLM-160M | ✓ | #1 | 0.3740 |
| F2LLM-330M | ✓ | #1 | 0.4040 |
| F2LLM-0.6B | ✓ | #1 | 0.7000 |
| F2LLM-1.7B | ✓ | #1 | 0.8300 |
| qwen3-0.6b | ✓ | #1 | 0.5060 |
| qwen3-4b | ✓ | #1 | 0.5970 |
| jina-nano-mlx | ✓ | #1 | 0.4590 |
| jina-small-mlx | ✓ | #1 | 0.5130 |

#### 用例 #8 — _reset_ckpt_args 保留 imgsz/data/task

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #1 | 0.5600 |
| F2LLM-80M | ✓ | #1 | 0.3880 |
| F2LLM-160M | ✓ | #1 | 0.3900 |
| F2LLM-330M | ✓ | #1 | 0.4410 |
| F2LLM-0.6B | ✓ | #1 | 0.6820 |
| F2LLM-1.7B | ✓ | #1 | 0.8370 |
| qwen3-0.6b | ✓ | #1 | 0.6940 |
| qwen3-4b | ✓ | #1 | 0.6340 |
| jina-nano-mlx | ✓ | #1 | 0.5120 |
| jina-small-mlx | ✓ | #1 | 0.5280 |

#### 用例 #9 — add_callback/clear_callback/reset_callbacks

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #1 | 0.5900 |
| F2LLM-80M | ✓ | #1 | 0.5520 |
| F2LLM-160M | ✓ | #1 | 0.5630 |
| F2LLM-330M | ✓ | #1 | 0.5970 |
| F2LLM-0.6B | ✓ | #1 | 0.7590 |
| F2LLM-1.7B | ✓ | #1 | **0.8550** |
| qwen3-0.6b | ✓ | #1 | 0.6390 |
| qwen3-4b | ✓ | #1 | 0.7030 |
| jina-nano-mlx | ✓ | #1 | 0.6270 |
| jina-small-mlx | ✓ | #1 | 0.6080 |

#### 用例 #10 — embed 默认取倒数第二层 ⚠️ **最难用例**

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #4 | 0.4340 |
| F2LLM-80M | ✗ | — | — |
| F2LLM-160M | ✓ | #19 | 0.1180 |
| F2LLM-330M | ✗ | — | — |
| F2LLM-0.6B | ✓ | #11 | 0.5210 |
| F2LLM-1.7B | ✓ | #5 | 0.7190 |
| qwen3-0.6b | ✓ | #2 | 0.4210 |
| qwen3-4b | ✓ | #1 | 0.4540 |
| jina-nano-mlx | ✓ | #1 | 0.3150 |
| jina-small-mlx | ✓ | #3 | 0.2920 |

#### 用例 #11 — track 注册跟踪器、低置信度阈值

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #1 | 0.4470 |
| F2LLM-80M | ✓ | #1 | 0.3710 |
| F2LLM-160M | ✓ | #2 | 0.3130 |
| F2LLM-330M | ✓ | #2 | 0.3580 |
| F2LLM-0.6B | ✓ | #3 | 0.5820 |
| F2LLM-1.7B | ✓ | #1 | 0.7760 |
| qwen3-0.6b | ✓ | #2 | 0.5290 |
| qwen3-4b | ✓ | #1 | 0.5800 |
| jina-nano-mlx | ✓ | #1 | 0.4460 |
| jina-small-mlx | ✓ | #1 | 0.4560 |

#### 用例 #12 — 通过 task_map 动态加载 model/trainer 等

| 模型 | 命中 | 排名 | 分数 |
|------|:----:|:----:|:----:|
| embeddinggemma-300m | ✓ | #1 | 0.4960 |
| F2LLM-80M | ✓ | #1 | 0.4350 |
| F2LLM-160M | ✓ | #1 | 0.4330 |
| F2LLM-330M | ✓ | #1 | 0.4660 |
| F2LLM-0.6B | ✓ | #1 | 0.6730 |
| F2LLM-1.7B | ✓ | #1 | 0.8070 |
| qwen3-0.6b | ✓ | #1 | 0.6300 |
| qwen3-4b | ✓ | #1 | 0.5460 |
| jina-nano-mlx | ✓ | #1 | 0.4640 |
| jina-small-mlx | ✓ | #1 | 0.5040 |

---

### 三、关键发现

**最佳模型：`qwen3-embedding:4b:q4_k_m` 与 `jina-embeddings-v5-nano-mlx`**
- `qwen3-4b`: Recall@1 / 3 / 5 / 10 / 20 全部 **100%**，MRR = **1.0000**，是唯一一个所有用例都排第一的模型
- `jina-nano-mlx`: 同样 **100%** Recall@1~20，MRR = **1.0000**，在全部 12 个用例中均排名 #1

**最难用例：用例 #10 — `embed 默认取倒数第二层`**
- 2 个模型（F2LLM-80M、F2LLM-330M）完全**未命中**
- 2 个模型（F2LLM-160M、F2LLM-0.6B）命中但排名在 10+，分数极低
- F2LLM-1.7B 在此用例上表现最好（#5, 0.7190）
- jina 模型虽然命中排名高（nano #1, small #3），但分数偏低（0.315, 0.292）

**未命中记录（共 2 次）：**
1. `F2LLM-80M` — 用例 #10 未命中（Top-3 最高分仅 0.204）
2. `F2LLM-330M` — 用例 #10 未命中（Top-3 最高分仅 0.292）

**分数天花板模型：`F2LLM-1.7B`**
- 100% 命中率，平均分 **0.8106**（最高），在 8/12 用例中排名第一，4 个用例分数超过 0.83

**综合排名（按 MRR 排序）：**
1. 🥇 `qwen3-4b` — MRR 1.0000
1. 🥇 `jina-nano-mlx` — MRR 1.0000
3. 🥉 `jina-small-mlx` — MRR 0.9444
4. `F2LLM-1.7B` — MRR 0.8917
5. `F2LLM-330M` — MRR 0.8750
6. `qwen3-0.6b` — MRR 0.8500
7. `F2LLM-0.6B` — MRR 0.8131
8. `F2LLM-160M` — MRR 0.8053
9. `F2LLM-80M` — MRR 0.7528
10. `embeddinggemma-300m` — MRR 0.6926
