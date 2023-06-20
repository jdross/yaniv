from yaniv import YanivGame, AIPlayer, Player

def print_player_hand(player):
    print(f"\n{player.name}'s hand:")
    for i, card in enumerate(player.hand):
        print(f"{i}: {str(card)}")

def print_discard_options(options):
    print("\nDiscard pile options:")
    for i, option in enumerate(options):
        print(f"{i}: {option}")

def main():
    print("Welcome to Yaniv!")

    # Initialize a game
    player_names = input("Enter player names, separated by commas: ").split(",")
    ai_players = int(input("Enter number of AI players: "))  # Ask for number of AI players
    
    players = []
    players += [Player(name.strip()) for name in player_names if name != '']
    players += [AIPlayer(f"AI {i+1}") for i in range(ai_players)]  # Add AI players to the list

    game = YanivGame(players)
    game.start_game()

    while True:
        # Start a turn
        current_player, discard_options = game.start_turn()
        print(f"\nIt's {current_player.name}'s turn.")

        if not isinstance(current_player, AIPlayer):
            print_player_hand(current_player)
            print_discard_options(discard_options)

        if game.can_declare_yaniv(current_player):
            if isinstance(current_player, AIPlayer):
                declare_yaniv = current_player.should_declare_yaniv()  # Use AIPlayer's method to decide whether to declare Yaniv
            else:
                declare_yaniv = input("Do you want to declare Yaniv? (yes/no): ").strip().lower() == 'yes'
            
            if declare_yaniv:
                print(f"{current_player.name} declared Yaniv!")
                update_info, eliminated_players, winner = game.declare_yaniv(current_player)
                if 'assaf' in update_info:
                    print(f"{update_info['assaf']['assafed'].name} got Assafed by {update_info['assaf']['assafed_by'].name}!")
                if 'reset_players' in update_info:
                    for player in update_info['reset_players']:
                        print(f"{player.name} reset!")
                for player in eliminated_players:
                    print(f"{player.name} was eliminated!")
                print ("\nScores:")
                for player in players:
                    print(f"{player.name}: {player.score}")
                if winner:
                    print(f"\n{winner.name} wins the game!")
                    break
                continue
        
        action = None
        if not isinstance(current_player, AIPlayer):
            discard_indices = input("Enter indices of cards to discard (comma separated): ").strip().split(',')
            discard_indices = [int(index) for index in discard_indices]

            draw_source = input("Draw from (d)eck or (p)ile?: ").strip().lower()
            if draw_source == 'd':
                draw_action = 'deck'
            else:
                pile_index = 0 if len(discard_indices)==1 else int(input("Enter the index of card from discard pile to draw: ").strip())
                draw_action = pile_index

            action = {
                'discard': [current_player.hand[i] for i in discard_indices],
                'draw': draw_action
            }
        action = game.play_turn(current_player, action)
        print(f"{current_player.name} discarded {action['discard']}")
        if isinstance(current_player, AIPlayer):
            if action['draw'] != 'deck':
                print(f"{current_player.name} took {str(current_player.hand[-1])} and ended their turn with {len(current_player.hand)} cards.")
            else:
                print(f"{current_player.name} drew from the deck.")
        else:
            print(f"{current_player.name} drew a {str(current_player.hand[-1])} and ended their turn.")

if __name__ == "__main__":
    main()