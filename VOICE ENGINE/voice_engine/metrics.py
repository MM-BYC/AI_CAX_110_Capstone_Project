from contextlib import contextmanager
from dataclasses import dataclass, field
from time import perf_counter


@dataclass
class LatencyTrace:
    direction: str
    stages_ms: dict[str, float] = field(default_factory=dict)

    @property
    def total_ms(self) -> float:
        return sum(self.stages_ms.values())


class StageTimer:
    def __init__(self, trace: LatencyTrace):
        self.trace = trace

    @contextmanager
    def stage(self, name: str):
        start = perf_counter()
        try:
            yield
        finally:
            elapsed_ms = (perf_counter() - start) * 1000
            self.trace.stages_ms[name] = self.trace.stages_ms.get(name, 0.0) + elapsed_ms
