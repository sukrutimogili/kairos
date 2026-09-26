package com.kairos.sample.controller;

import com.kairos.sample.service.UserService;

public class UserController {
    private final UserService userService = new UserService();

    public String handleGetUserRequest(String userId) {
        return userService.getUserProfile(userId);
    }
}
