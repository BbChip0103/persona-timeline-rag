"""Source-post schema; event dates are not copied from upload timestamps."""

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class Post:
    person_id: str
    post_id: str
    posted_at: str
    caption: str
    source_url: str | None
    source_file: str
    is_video: bool
    is_ad: bool | None
    image_files: list[str] = field(default_factory=list)
    event_date: str | None = None
    event_date_basis: str = "unknown"

    def to_dict(self) -> dict:
        return asdict(self)
