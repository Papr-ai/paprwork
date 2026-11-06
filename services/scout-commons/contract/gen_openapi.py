"""python gen_openapi.py > openapi.json — CI fails if the committed file differs."""
import json

from commons_contract.app import app

print(json.dumps(app.openapi(), indent=2, sort_keys=True))
