// Placeholder name pool for NPC drivers - ~200 names so a room full of bots doesn't repeat itself.
// Real players are excluded from ever colliding with these (see pickNpcName below), so it doesn't
// need to coordinate with the online_players uniqueness system at all.
export const NPC_NAMES = [
  'Alex', 'Amélie', 'Antoine', 'Arianne', 'Arthur', 'Aurélie', 'Benoit', 'Béatrice', 'Camille', 'Charles',
  'Chloé', 'Clara', 'Claude', 'Colin', 'Daniel', 'Danielle', 'David', 'Denis', 'Diane', 'Dominic',
  'Dominique', 'Édouard', 'Élise', 'Emma', 'Émile', 'Emmanuel', 'Éric', 'Étienne', 'Eugène', 'Fabien',
  'Félix', 'Florence', 'Francis', 'François', 'Frédéric', 'Gabriel', 'Gabrielle', 'Geneviève', 'Georges', 'Gilles',
  'Guillaume', 'Guy', 'Hélène', 'Henri', 'Hugo', 'Isabelle', 'Jacques', 'Jasmine', 'Jean', 'Jérôme',
  'Joseph', 'Josée', 'Julie', 'Julien', 'Justine', 'Karine', 'Laurence', 'Laurent', 'Léa', 'Léon',
  'Lise', 'Louis', 'Louise', 'Luc', 'Lucie', 'Lucien', 'Ludovic', 'Madeleine', 'Marc', 'Marcel',
  'Margaux', 'Marguerite', 'Marie', 'Marielle', 'Marion', 'Martin', 'Mathieu', 'Mathilde', 'Maude', 'Maxime',
  'Michel', 'Michèle', 'Mireille', 'Nadia', 'Nathalie', 'Nicolas', 'Noémie', 'Odette', 'Olivier', 'Pascal',
  'Patrice', 'Paul', 'Pauline', 'Philippe', 'Pierre', 'Raphaël', 'Raymond', 'Rémi', 'René', 'Robert',
  'Rosalie', 'Roxanne', 'Sabrina', 'Sébastien', 'Sévérine', 'Simon', 'Sophie', 'Stéphane', 'Suzanne', 'Sylvain',
  'Sylvie', 'Théo', 'Thérèse', 'Thomas', 'Valérie', 'Vincent', 'Virginie', 'Xavier', 'Yves', 'Yvon',
  'Aiden', 'Amara', 'Amir', 'Ava', 'Beatrix', 'Benjamin', 'Bianca', 'Caleb', 'Carmen', 'Cecilia',
  'Cedric', 'Chase', 'Cyrus', 'Delphine', 'Desmond', 'Eleanor', 'Elias', 'Elliot', 'Esme', 'Ezra',
  'Fatima', 'Felix', 'Freya', 'Gavin', 'Georgia', 'Hana', 'Harvey', 'Hazel', 'Heather', 'Hector',
  'Ines', 'Iris', 'Ivy', 'Jasper', 'Jonah', 'Kai', 'Kamal', 'Layla', 'Leandro', 'Leo',
  'Levi', 'Liana', 'Lila', 'Lior', 'Luca', 'Lucia', 'Malia', 'Marcus', 'Mateo', 'Maya',
  'Mia', 'Milo', 'Naomi', 'Nasser', 'Nikolai', 'Nina', 'Noor', 'Oscar', 'Otto', 'Owen',
  'Penelope', 'Priya', 'Quentin', 'Reza', 'River', 'Roman', 'Rosa', 'Ruby', 'Sam', 'Sana',
  'Sasha', 'Selma', 'Silas', 'Stella', 'Sven', 'Talia', 'Tariq', 'Tessa', 'Theo', 'Uma',
  'Victor', 'Vivian', 'Wesley', 'Willa', 'Xander', 'Yara', 'Yusuf', 'Zara', 'Zeke', 'Zoe'
]

// Picks a random name not already used by anyone (human or bot) currently in the room - avoids
// colliding with the room-scoped `players.find(p => p.name === x)` lookups used throughout App.jsx.
export function pickNpcName(existingNames) {
  const used = new Set(existingNames)
  const available = NPC_NAMES.filter((n) => !used.has(n))
  const pool = available.length ? available : NPC_NAMES
  return pool[Math.floor(Math.random() * pool.length)]
}
