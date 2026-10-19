package com.mirattic.sync.presence;

import java.util.Collection;

/**
 * Who is in a room, or what it is, changed (any `room:update`), or a user's privacy did: their friends' view of them
 * may show another public room (decision 114). Handled once the change commits.
 */
public record RoomsChanged(Collection<String> userIds) {}
