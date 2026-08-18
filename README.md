# Youtube-Digest-Bilibili-Added
Secondary creation：Youtube Digest By zarazhangrui

Added Bilibili reading/parsing support.

Swapped out the Supadata API to avoid registration; now directly uses YouTube and Bilibili's built-in AI subtitles. (Next step: figure out a fallback when built-in subtitles aren't available.)

Replaced Deepseek API with a custom endpoint + API key setup. Now you can use any token plan or even piggyback on free tokens from providers!

Integrated one-click transcript download.

Added bilingual English and Chinese versions for Keynotes.

During development, I built this entirely through natural language conversations with LLMs, and tried out qoder -qwen3.8max (is it actually a bit smarter?).
Thanks Again for zarazhangrui
