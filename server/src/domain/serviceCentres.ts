// Service centres offered in the chat select card (PD8): a fixed, clearly fictional list. None of these is a real
// business. The server's list is the only one trusted: the client's option values are re-checked against it.
import type { ServiceCentreValue } from "@device-repair/shared/fields";

// Each entry is frozen too: the list is shared by every session.
export const SERVICE_CENTRES: readonly Readonly<ServiceCentreValue>[] = Object.freeze(
  [
    { id: "blr-koramangala", name: "Koramangala Demo Repair Centre", city: "Bengaluru" },
    { id: "blr-whitefield", name: "Whitefield Demo Repair Centre", city: "Bengaluru" },
    { id: "mum-andheri", name: "Andheri Demo Repair Centre", city: "Mumbai" },
    { id: "mum-dadar", name: "Dadar Demo Repair Centre", city: "Mumbai" },
    { id: "del-saket", name: "Saket Demo Repair Centre", city: "Delhi" },
    { id: "del-karol-bagh", name: "Karol Bagh Demo Repair Centre", city: "Delhi" },
  ].map((centre) => Object.freeze(centre)),
);

export function findServiceCentre(id: string): ServiceCentreValue | null {
  const centre = SERVICE_CENTRES.find((c) => c.id === id);
  return centre ? { ...centre } : null;
}

/** "Koramangala Demo Repair Centre, Bengaluru": the card's option label. */
export const serviceCentreLabel = (centre: ServiceCentreValue): string => `${centre.name}, ${centre.city}`;
