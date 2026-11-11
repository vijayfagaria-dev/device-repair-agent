"""Service centres offered in the chat select card (PD8): a fixed, clearly fictional list. None of these is a real
business. The server's list is the only one trusted: the client's option values are re-checked against it."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ServiceCentre:
    id: str
    name: str
    city: str

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "city": self.city}


SERVICE_CENTRES: tuple[ServiceCentre, ...] = (
    ServiceCentre("blr-koramangala", "Koramangala Demo Repair Centre", "Bengaluru"),
    ServiceCentre("blr-whitefield", "Whitefield Demo Repair Centre", "Bengaluru"),
    ServiceCentre("mum-andheri", "Andheri Demo Repair Centre", "Mumbai"),
    ServiceCentre("mum-dadar", "Dadar Demo Repair Centre", "Mumbai"),
    ServiceCentre("del-saket", "Saket Demo Repair Centre", "Delhi"),
    ServiceCentre("del-karol-bagh", "Karol Bagh Demo Repair Centre", "Delhi"),
)


def find_service_centre(centre_id: str) -> dict[str, str] | None:
    """A fresh copy of the centre as the record value ({id, name, city}), or None."""
    for centre in SERVICE_CENTRES:
        if centre.id == centre_id:
            return centre.to_dict()
    return None


def service_centre_label(centre: ServiceCentre | dict[str, str]) -> str:
    """ "Koramangala Demo Repair Centre, Bengaluru": the card's option label."""
    if isinstance(centre, dict):
        return f"{centre['name']}, {centre['city']}"
    return f"{centre.name}, {centre.city}"
