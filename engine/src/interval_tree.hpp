#ifndef ELASTISCHED_INTERVALTREE_HPP
#define ELASTISCHED_INTERVALTREE_HPP

#include <memory>
#include <iostream>
#include <utility>
#include <vector>

#include "interval.hpp"

template<typename T, typename U>
struct Node {
    std::unique_ptr<Interval<T>> interval;
    U value;
    T max;
    std::unique_ptr<Node<T, U>> left;
    std::unique_ptr<Node<T, U>> right;
    
    Node(std::unique_ptr<Interval<T>> interval_ptr, U node_value)
        : interval(std::move(interval_ptr)),
          value(node_value),
          max(interval->get_high()),
          left(nullptr),
          right(nullptr) {}
};

template<typename T, typename U>
class IntervalTree {
private:
    std::unique_ptr<Node<T, U>> root;
    
    std::unique_ptr<Node<T, U>> insert(std::unique_ptr<Node<T, U>> node,
                                       std::unique_ptr<Interval<T>> interval_ptr,
                                       U value) {
        if (!node) {
            return std::make_unique<Node<T, U>>(std::move(interval_ptr), value);
        }
        T interval_low = interval_ptr->get_low();
        T interval_high = interval_ptr->get_high();

        if (interval_low < node->interval->get_low()) {
            node->left = insert(std::move(node->left), std::move(interval_ptr), value);
        } else {
            node->right = insert(std::move(node->right), std::move(interval_ptr), value);
        }

        node->max = std::max(node->max, interval_high);
        return node;
    }

    bool do_overlap(Interval<T>* left, Interval<T>* right) const {
        return left->overlaps(*right);
    }

    Node<T, U>* overlap_search(Node<T, U>* node, Interval<T>& interval) const {
        if (!node)
            return nullptr;

        if (do_overlap(node->interval.get(), &interval))
            return node;

        if (node->left && node->left->max >= interval.get_low())
            return overlap_search(node->left.get(), interval);

        return overlap_search(node->right.get(), interval);
    }

    void find_overlapping(const Node<T, U>* node,
                          const Interval<T>& key,
                          std::vector<const Interval<T>*>& result) const {
        if (!node) return;

        if (node->interval->overlaps(key)) {
            result.push_back(node->interval.get());
        }

        if (node->left && node->left->max >= key.get_low()) {
            find_overlapping(node->left.get(), key, result);
        }
        if (node->right && node->interval->get_low() <= key.get_high()) {
            find_overlapping(node->right.get(), key, result);
        }
    }

    std::unique_ptr<Node<T, U>> clone_node(const std::unique_ptr<Node<T, U>>& node) const {
        if (!node)
            return nullptr;

        auto new_interval = std::make_unique<Interval<T>>(*node->interval);
        auto new_node = std::make_unique<Node<T, U>>(std::move(new_interval), node->value);
        new_node->max = node->max;
        new_node->left = clone_node(node->left);
        new_node->right = clone_node(node->right);
        return new_node;
    }

    void print_in_order(const Node<T, U>* node) const {
        if (!node) return;
        print_in_order(node->left.get());
        std::cout << "[" << node->interval->get_low() << ", " << node->interval->get_high()
                  << "] max=" << node->max << std::endl;
        print_in_order(node->right.get());
    }

public:
    IntervalTree() = default;
    
    IntervalTree(const IntervalTree<T, U>& other) {
        root = clone_node(other.root);
    }
    
    IntervalTree<T, U>& operator=(const IntervalTree<T, U>& other) {
        if (this != &other) {
            root = clone_node(other.root);
        }
        return *this;
    }
    
    void insert(T low, T high, U value) {
        auto interval = std::make_unique<Interval<T>>(low, high);
        root = insert(std::move(root), std::move(interval), value);
    }
    
    void insert(Interval<T> interval, U value) {
        auto i = std::make_unique<Interval<T>>(interval);
        root = insert(std::move(root), std::move(i), value);
    }

    Interval<T>* search_overlap(Interval<T> query) const {
        auto result = overlap_search(root.get(), query);
        return result ? result->interval.get() : nullptr;
    }
    
    Interval<T>* search_overlap(T low, T high) const {
        return search_overlap(Interval<T>(low, high));
    }

    std::vector<const Interval<T>*> find_overlapping(const Interval<T>& key) const {
        std::vector<const Interval<T>*> result;
        find_overlapping(root.get(), key, result);
        return result;
    }

    U* search_value(T low, T high) const {
        Interval<T> query(low, high);
        auto result = overlap_search(root.get(), query);
        return result ? &result->value : nullptr;
    }

    U* search_value(Interval<T> interval) const {
        return search_value(interval.get_low(), interval.get_high());
    }

    bool is_in(const Interval<T>& interval) {
        return search_overlap(interval.get_low(), interval.get_high()) != nullptr;
    }
    
    void print() const {
        print_in_order(root.get());
    }
};

#endif // ELASTISCHED_INTERVALTREE_HPP
