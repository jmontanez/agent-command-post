# command-post-relay

The return channel for Agent Command Post. The command post's hooks show what every Claude Code session on your computer is doing. With this relay installed, you can also tap an agent on the board, type an answer or new orders, and the agent receives it as if you had typed it in its session.

While a session waits on you, the relay checks the command post for messages every 15 seconds (every 45 seconds while the agent is working) and submits anything you sent. Sessions that can't reach http://localhost:7600, such as cloud sessions, are left alone: the relay does nothing there.

Needs Agent Command Post running on the same computer. Its installer sets this relay up for you.
