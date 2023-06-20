# Yaniv Card Game Engine & Interface
A game engine and simple "AI" player for the Yaniv card game

- **yaniv.py** has all the game logic and API for 'playing' a game of Yaniv. 
- **yaniv-cli.py** is a very basic reference implementation of the game, helpful to create better clients. It runs in the command line
- **card.py**, **player.py** and **aiplayer.py** are required classes and self-explanatory

### House rules:
- Game is to 100
- Resets of -50 points landing at multiples of 50
- 5 or fewer points to declare Yaniv
- Assaf'ed players get 30 points & everyone else gets 0 points
- No slapdowns (because not implemented yet)

### Future plans:
- Implement a basic game server for creating games and loading game states from a short serialized string
- Implement a basic web UI
- Implement slapdowns
- Make the AI smarter
