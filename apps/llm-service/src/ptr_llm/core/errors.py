"""Public-safe domain failure constants; raw model output is never an error."""


class CoreError(Exception):
    def __init__(self, code="TURN_FAILED", reason=None):
        self.code = code
        self.reason = reason or code
        super().__init__(self.reason)
