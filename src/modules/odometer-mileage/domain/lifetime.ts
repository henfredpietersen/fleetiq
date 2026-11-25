// lifetime_km = displayed_km + offset_km (DB §8 odometer_segments). Mirror of the SQL function odometer_lifetime_km() (migration 051).
export const lifetimeKm = (displayedKm: number, offsetKm: number): number =>
  displayedKm + offsetKm;
