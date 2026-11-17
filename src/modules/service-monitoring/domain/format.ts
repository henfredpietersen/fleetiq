export const formatKm = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n.toLocaleString("en-ZA")} km`;

export const formatDate = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-ZA", {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
