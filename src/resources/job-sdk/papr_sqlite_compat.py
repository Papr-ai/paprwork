"""sqlite3-shaped results for databases reached through the Papr gateway.

Jobs (papr_db) and app backend actions (backend papr_db helper) both talk to the
gateway over HTTP, which returns rows as JSON objects. Code written by people
and agents uses the sqlite3 idioms, so both helpers return these types. One
implementation means a pattern that works in a job also works in a backend.

Row behaves like sqlite3.Row AND like a dict:
  row["name"], row[0], name, qty = row, dict(zip(cols, row)), tuple(row),
  dict(row), row.keys(), row.items(), {**row}, json.dumps(row)
Cursor is the list of rows plus the sqlite3.Cursor surface:
  fetchone / fetchmany / fetchall, rowcount, lastrowid, description, arraysize.
"""

from __future__ import annotations

from typing import Any, Iterable


class Row(dict):
    """A row usable as sqlite3.Row (iterates values, int index) and as a dict."""

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return list(self.values())[key]
        if isinstance(key, slice):
            return tuple(self.values())[key]
        return super().__getitem__(key)

    def __iter__(self):  # type: ignore[override]
        # sqlite3.Row and tuple rows iterate values; zip/unpack idioms rely on it.
        return iter(self.values())

    def __eq__(self, other: object) -> bool:
        if isinstance(other, tuple):
            return tuple(self.values()) == other
        return dict.__eq__(self, other)

    __hash__ = None  # type: ignore[assignment]


def as_row(value: Any) -> Any:
    if isinstance(value, Row) or not isinstance(value, dict):
        return value
    return Row(value)


class Cursor(list):
    """Rows from one statement, with the sqlite3.Cursor read API.

    Also a list, so older code that treated execute() results as a list of
    dicts (len, indexing, iteration) keeps working.
    """

    arraysize = 1

    def __init__(
        self,
        rows: Iterable[Any] = (),
        rowcount: int = -1,
        lastrowid: int | None = None,
        is_select: bool = True,
    ) -> None:
        super().__init__(as_row(r) for r in rows)
        self.rowcount = rowcount
        self.lastrowid = lastrowid
        self._pos = 0
        if not is_select:
            self.description = None
        elif self and isinstance(self[0], dict):
            self.description = tuple((k, None, None, None, None, None, None) for k in self[0].keys())
        else:
            self.description = ()

    def fetchone(self) -> Any:
        if self._pos >= len(self):
            return None
        row = list.__getitem__(self, self._pos)
        self._pos += 1
        return row

    def fetchmany(self, size: int | None = None) -> list[Any]:
        n = self.arraysize if size is None else size
        out = list(list.__getitem__(self, slice(self._pos, self._pos + n)))
        self._pos += len(out)
        return out

    def fetchall(self) -> list[Any]:
        out = list(list.__getitem__(self, slice(self._pos, None)))
        self._pos = len(self)
        return out

    def close(self) -> None:
        return None
