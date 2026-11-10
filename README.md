# PDF Paper Translator

An Agent Skill that translates research papers using the current chat model and saves each completed PDF. Translate one paper or a queue, choose the target language and page range, and export either a translated PDF or alternating original and translated pages.

## Use the skill

Place the `pdf-paper-translator` directory in your Agent's skill directory. In DeepSeek Harness, use `/pdf-paper-translator`. In Codex, use `$pdf-paper-translator`. Attach papers or provide paths that the Agent can read.

The Agent needs Node.js 22+, filesystem tools, and a way to keep a background command running. A separate translation API key is optional. For details, see [SKILL.md](SKILL.md) and [engine setup](references/setup.md).

## External layout engine

Install the upstream engine separately. The Skill checks for `pdf2zh_next`, asks before installing a missing dependency, and invokes its public CLI. Existing installations can be configured with `PDF_TRANSLATE_ENGINE`.

- [PDFMathTranslate-next 2.10.2](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/releases/tag/v2.10.2), licensed under [AGPL-3.0](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/LICENSE).
- [BabelDOC](https://github.com/funstory-ai/BabelDOC), an upstream dependency of PDFMathTranslate-next. Version 0.7.1 was tested locally. It is licensed under [AGPL-3.0](https://github.com/funstory-ai/BabelDOC/blob/v0.7.1/LICENSE).

## License

The Skill source is offered under [GNU AGPL version 3](LICENSE). Upstream projects retain their own copyright and license notices.
