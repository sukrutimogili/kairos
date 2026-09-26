package com.kairos.sample.service;

import com.kairos.sample.repository.UserRepository;
import com.kairos.sample.util.Logger;

public class UserService {
    private final UserRepository userRepository = new UserRepository();

    public String getUserProfile(String id) {
        Logger.info("UserService fetching profile for " + id);
        return userRepository.findUserById(id);
    }
}
