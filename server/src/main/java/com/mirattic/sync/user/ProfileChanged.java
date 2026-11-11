package com.mirattic.sync.user;

/** The user's name or photo changed (from Mirattic Auth): their friends' and rooms' open screens refetch it. */
public record ProfileChanged(String userId) {}
