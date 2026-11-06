# Scout Commons API contract

Pydantic models for §7 of "Scout Commons — Long-term Architecture (v2)". Models only, no engines.
`openapi.json` is generated from them (same approach as the memory repo) so Stainless can build SDKs.

```
pip install pydantic==2.14.1 fastapi==0.128.8 pytest httpx
python gen_openapi.py > openapi.json
pytest -q
```

Open items for review (Amir, Shawkat): see the PR description.
