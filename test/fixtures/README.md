# 研究生页面诊断 fixtures

这里仅存放由应用“复制诊断信息”生成并再次人工检查过的脱敏 JSON。

允许保留页面路径、有限的 id/class token、通用按钮文字、脚本路径、疑似选课函数名，以及同域 XHR/fetch 的 method/path/status/resourceType。不得保存完整 HTML、Cookie、storage 值、学号、姓名、密码、token/ticket/code 参数、请求或响应头、请求或响应正文。

当前研究生 adapter 会按相似框架尝试复用原选课系统流程。未来获得研究生账号环境的诊断后，应先添加 fixture 测试，再用真实证据替换存在差异的 selector、字段或提交步骤。
