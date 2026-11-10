# 安装和模型配置

把整个 `pdf-paper-translator` 文件夹放进目标 Agent 的 Skill 搜索目录。DeepSeek Harness 支持 `~/.dsh/skills/pdf-paper-translator`，聊天入口是 `/pdf-paper-translator`。其他 Agent 使用各自的 Skill 目录和调用方式。运行环境需要 Node.js 22 或以上、可读取的 PDF、可写的输出目录，以及能在后台保留命令进程的 Agent 工具。默认从当前聊天获得译文。在支持后台任务的 Harness 配置里，用 pwsh 或 bash 的 run_in_background 启动，通过 job_output 读取任务目录和输出路径。当前聊天的 token 用量由聊天平台计量，脚本只知道转交了多少个待译请求。

## 排版引擎

Skill 通过公开命令行调用单独安装的 `pdf2zh_next`。先运行 `node scripts/translate.mjs --check-engine`。收到 `state=ready` 后直接使用。如有独立安装路径，设置 `PDF_TRANSLATE_ENGINE` 为可执行文件的绝对路径。

缺少引擎时，先征得用户对安装操作的同意。将从 PyPI 安装 [PDFMathTranslate-next 2.10.2](https://pypi.org/project/pdf2zh-next/2.10.2/) 及其依赖 BabelDOC。两个项目都使用 [AGPL-3.0](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/LICENSE)。安装使用用户目录下的独立环境，首次翻译时引擎可能下载版面模型与字体。

Windows 的 PowerShell：

~~~powershell
$engineDir = Join-Path $env:USERPROFILE '.pdf-paper-translator\engine-2.10.2'
py -3.12 -m venv $engineDir
& (Join-Path $engineDir 'Scripts\python.exe') -m pip --isolated install --index-url https://pypi.org/simple 'pdf2zh-next==2.10.2'
~~~

macOS 或 Linux：

~~~sh
engine_dir="$HOME/.pdf-paper-translator/engine-2.10.2"
python3.12 -m venv "$engine_dir"
"$engine_dir/bin/python" -m pip --isolated install --index-url https://pypi.org/simple 'pdf2zh-next==2.10.2'
~~~

装好后再次检查引擎并继续待翻译的任务。用户拒绝安装时结束本次任务。没有文本层的扫描件需先 OCR。

## 可选的独立 API

用户明确要求独立的模型接口时，运行脚本时加入 --api，并在运行环境中配置以下变量。

| 变量 | 用途 |
| --- | --- |
| `PDF_TRANSLATE_BASE_URL` | 兼容 Chat Completions 的 API 根地址。例如 DeepSeek 使用 `https://api.deepseek.com`。脚本追加 `/chat/completions`。本机服务可以用 HTTP。 |
| `PDF_TRANSLATE_MODEL` | 提供方实际可用的模型 ID。也可以逐次用 `--model` 覆盖。 |
| `PDF_TRANSLATE_API_KEY` | 模型服务的密钥。通过 Agent 的秘密配置或进程环境传入。 |

Windows 上可以在 PowerShell 里为当前终端设置变量。输入密钥时终端会遮住内容。

~~~powershell
$env:PDF_TRANSLATE_BASE_URL = 'https://api.deepseek.com'
$env:PDF_TRANSLATE_MODEL = Read-Host '模型 ID'
$secret = Read-Host '模型 API 密钥' -AsSecureString
$env:PDF_TRANSLATE_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
~~~

从配置了变量的环境启动 Agent 或直接运行脚本。桌面 Agent 已启动时，请完全退出后从该环境重新启动。HTTP 401、402、403、404 会停止剩余任务，修好密钥、额度、权限或模型地址后，从未完成的文件继续。单篇文件损坏时队列会继续。
