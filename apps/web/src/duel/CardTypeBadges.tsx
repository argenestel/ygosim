const paths: Record<string, string> = {
  Spell: "M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z",
  Trap: "M4 4h16v9l-8 8-8-8zM8 9h8M12 7v8",
  Monster: "M12 3l8 5v8l-8 5-8-5V8zM8 10l2 2m6-2-2 2M9 16h6",
  Continuous: "M12 12c-3-6-9-6-9 0s6 6 9 0c3-6 9-6 9 0s-6 6-9 0z",
  "Quick-Play": "M13 2L4 14h7l-1 8L20 9h-7z",
  Counter: "M8 4L3 9l5 5M3 9h11a6 6 0 010 12",
  Field: "M3 5h18v14H3zM3 12h18M9 5v14M15 5v14",
  Equip: "M15 3l6 6-10 10-6-6zM3 21l5-5M5 13l6 6",
  Ritual: "M5 4h14v5a7 7 0 01-14 0zM12 16v5M8 21h8",
  Fusion: "M14 8a6 6 0 10-6 10M10 6a6 6 0 106 10",
  Synchro: "M12 3a9 9 0 100 18 9 9 0 000-18M12 7a5 5 0 100 10 5 5 0 000-10",
  Xyz: "M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z",
  Link: "M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4",
  Pendulum: "M12 3v9M5 5l7-2 7 2M12 12l5 5-5 5-5-5z",
  Normal: "M4 4h16v16H4zM8 8h8M8 12h8M8 16h5",
  Tuner: "M4 12h16M7 6v12M12 3v18M17 6v12",
  Effect: "M12 3a9 9 0 100 18 9 9 0 000-18M13 6l-5 7h4l-1 5 5-7h-4z",
};

export function CardIcon({ kind }: { kind: string }) {
  return <svg className="card-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind] ?? paths.Monster} /></svg>;
}

export function CardTypeBadges({ types, compact = false }: { types: string[]; compact?: boolean }) {
  const category = types.includes("Spell") ? "Spell" : types.includes("Trap") ? "Trap" : "Monster";
  const subtypes = types.filter(type => type !== category && paths[type]);
  const badges = [category, ...subtypes];
  if (category !== "Monster" && !subtypes.length) badges.push("Normal");
  return <span className={`card-type-badges ${category.toLowerCase()}${compact ? " compact" : ""}`}>
    {badges.map(type => <span key={type} className="card-type-badge" title={`${type}${type === category ? "" : ` ${category}`}`}>
      <CardIcon kind={type} /><span className={compact ? "sr-only" : undefined}>{type}</span>
    </span>)}
  </span>;
}
