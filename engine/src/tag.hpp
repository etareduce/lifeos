#ifndef ELASTISCHED_TAG_HPP
#define ELASTISCHED_TAG_HPP

#include <string>

/**
 * @brief Metadata label used to categorize jobs.
 */
class Tag {
private:
    std::string name;
    std::string description;

public:
    /**
     * @brief Construct a tag with optional description.
     */
    Tag(const std::string& name, const std::string& description = "");
    
    /** @brief Get tag name. */
    const std::string& get_name() const;
    /** @brief Set tag name. */
    void set_name(const std::string& name);
    /** @brief Get tag description. */
    const std::string& get_description() const;
    /** @brief Set tag description. */
    void set_description(const std::string& description);

    /** @brief Equality by tag name. */
    bool operator==(const Tag& other) const;
    /** @brief Inequality by tag name. */
    bool operator!=(const Tag& other) const;
    /** @brief Strict ordering by tag name. */
    bool operator<(const Tag& other) const;
};

#endif // ELASTISCHED_TAG_HPP
