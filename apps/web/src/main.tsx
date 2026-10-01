import { createRoot } from "react-dom/client";
import { useState } from "react";
import { activeDeck, playerName } from "./deck";
import { DuelScreen, type DuelLaunch } from "./duel/DuelScreen";
import { DeckBuilder } from "./screens/DeckBuilder";
import { Home } from "./screens/Home";
import "./styles.css";

type Screen = { s: "home" } | { s: "decks" } | { s: "duel"; launch: DuelLaunch; key: number };

function App() {
  const [screen, setScreen] = useState<Screen>({ s: "home" });
  if (screen.s === "decks") return <DeckBuilder onBack={() => setScreen({ s: "home" })} />;
  if (screen.s === "duel") return <DuelScreen key={screen.key} launch={screen.launch} deck={activeDeck()} name={playerName()} onExit={() => setScreen({ s: "home" })} />;
  return <Home onDecks={() => setScreen({ s: "decks" })} onPlay={(launch) => setScreen({ s: "duel", launch, key: Date.now() })} />;
}

// No StrictMode: its double-mount would open two duel sockets.
createRoot(document.getElementById("root")!).render(<App />);
