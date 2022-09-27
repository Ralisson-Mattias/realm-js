#include <memory>
#include <napi.h>

#include <realm/object-store/keypath_helpers.hpp>
#include <realm/object-store/results.hpp>
#include <realm/object-store/thread_safe_reference.hpp>
#include <realm/object-store/util/scheduler.hpp>
#include <realm/object-store/collection_notifications.hpp>
#include <realm/object-store/binding_context.hpp>
#include <realm/object-store/impl/object_notifier.hpp>
#include <realm/object-store/impl/realm_coordinator.hpp>
#include <realm/object-store/shared_realm.hpp>
#include <realm/object-store/sync/generic_network_transport.hpp>
#include <realm/object-store/util/event_loop_dispatcher.hpp>
#include <realm/util/functional.hpp>

namespace realm::js::node {
namespace {

// These types are exposed to JS in the spec.
// TODO look into moving some of this to realm-core
struct Helpers {
    static TableRef get_table(const SharedRealm& realm, StringData name)
    {
        return realm->read_group().get_table(name);
    }
    static TableRef get_table(const SharedRealm& realm, TableKey key)
    {
        return realm->read_group().get_table(key);
    }
    static query_parser::KeyPathMapping get_keypath_mapping(const SharedRealm& realm)
    {
        query_parser::KeyPathMapping mapping;
        populate_keypath_mapping(mapping, *realm);
        return mapping;
    }
    static Results results_from_query(const SharedRealm& realm, Query q)
    {
        auto ordering = q.get_ordering();
        return Results(realm, std::move(q), ordering ? *ordering : DescriptorOrdering());
    }
    static std::shared_ptr<_impl::ObjectNotifier> make_object_notifier(const SharedRealm& realm, const Obj& obj)
    {
        realm->verify_thread();
        realm->verify_notifications_available();
        auto notifier = std::make_shared<_impl::ObjectNotifier>(realm, obj.get_table()->get_key(), obj.get_key());
        _impl::RealmCoordinator::register_notifier(notifier);
        return notifier;
    }
    static std::pair<Obj, bool> get_or_create_object_with_primary_key(TableRef table, const Mixed& primary_key) {
        bool did_create;
        auto obj = table->create_object_with_primary_key(primary_key, &did_create);
        return {obj, did_create};
    };

    // Binding context is hard to wrap in part due to unique_ptr, and in part due to circular weak_ptr.
    // Also, some of the arguments passed are difficult to bind to, and unnecessary.
    // For now, making a helper, but may look in to auto-generating with core API changes.
    // TODO may need a hook for BindingContext destruction.
    struct BindingContextMethods {
        util::UniqueFunction<void(SharedRealm)> did_change;
        util::UniqueFunction<void(SharedRealm)> before_notify;
        util::UniqueFunction<void(SharedRealm)> schema_did_change;
    };

    static bool has_binding_context(const Realm& realm)
    {
        return bool(realm.m_binding_context);
    }
    static void set_binding_context(const SharedRealm& realm, BindingContextMethods methods)
    {
        struct TheBindingContext final : BindingContext {
            TheBindingContext(const SharedRealm& r, BindingContextMethods&& methods)
                : methods(std::move(methods))
            {
                // realm is a weak_ptr on the base.
                realm = r;
            }

            void did_change(std::vector<ObserverState> const&, std::vector<void*> const&, bool) override
            {
                if (methods.did_change)
                    methods.did_change(get_realm());
            }
            void before_notify() override
            {
                if (methods.before_notify)
                    methods.before_notify(get_realm());
            }
            void schema_did_change(realm::Schema const&) override
            {
                if (methods.schema_did_change)
                    methods.schema_did_change(get_realm());
            }

        private:
            SharedRealm get_realm()
            {
                if (auto ptr = realm.lock())
                    return ptr;
                throw std::runtime_error("Realm no longer exists");
            }

            BindingContextMethods methods;
        };

        realm->m_binding_context = std::make_unique<TheBindingContext>(realm, std::move(methods));
    }

    // This requires the ability to a) implement interfaces and b) mark which functions may be called off-thread.
    // Both are planned, but for now, providing a helper unlocks sync.
    using NetworkFuncSig = void(app::Request&&, util::UniqueFunction<void(const app::Response&)>&&);
    static std::shared_ptr<app::GenericNetworkTransport>
    make_network_transport(util::UniqueFunction<NetworkFuncSig> runRequest)
    {
        class Impl final : public app::GenericNetworkTransport {
        public:
            Impl(util::UniqueFunction<NetworkFuncSig>&& runRequest)
                : runRequest(std::move(runRequest))
            {
            }
            void send_request_to_server(app::Request&& request,
                                        util::UniqueFunction<void(const app::Response&)>&& completionBlock) override
            {
                runRequest(std::move(request), std::move(completionBlock));
            }
            util::EventLoopDispatcher<NetworkFuncSig> runRequest;
        };
        return std::make_shared<Impl>(std::move(runRequest));
    }
};

struct ObjectChangeSet {
    ObjectChangeSet() = default;
    /*implicit*/ ObjectChangeSet(const CollectionChangeSet& changes)
    {
        is_deleted = !changes.deletions.empty();
        for (const auto& [col_key_val, index_set] : changes.columns) {
            changed_columns.push_back(ColKey(col_key_val));
        }
    }

    bool is_deleted;
    std::vector<ColKey> changed_columns;
};

////////////////////////////////////////////////////////////

// These helpers are used by the generated code.

template <typename Container>
class [[nodiscard]] ContainerResizer {
public:
    explicit ContainerResizer(Container& container)
        : m_container(&container)
        , m_old_size(container.size())
    {
    }
    ContainerResizer(ContainerResizer&&) = delete;
    ~ContainerResizer()
    {
        if (m_old_size == 0) {
            // this can be a bit faster than resize()
            m_container->clear();
        }
        else {
            m_container->resize(m_old_size);
        }
    }

private:
    Container* const m_container;
    const size_t m_old_size;
};

// TODO consider allowing Number (double) with (u)int64_t.
inline int64_t extractInt64FromNode(const Napi::Value& input)
{
    bool lossless;
    auto output = input.As<Napi::BigInt>().Int64Value(&lossless);
    if (!lossless)
        throw Napi::RangeError::New(input.Env(), "Value doesn't fit in int64_t");
    return output;
}
inline uint64_t extractUint64FromNode(const Napi::Value& input)
{
    bool lossless;
    auto output = input.As<Napi::BigInt>().Uint64Value(&lossless);
    if (!lossless)
        throw Napi::RangeError::New(input.Env(), "Value doesn't fit in uint64_t");
    return output;
}

template <typename... Args>
inline Napi::Function bindFunc(Napi::Function func, Napi::Object self, Args... args)
{
    return func.Get("bind").As<Napi::Function>().Call(func, {self, args...}).template As<Napi::Function>();
}

[[noreturn]] REALM_NOINLINE inline void throwNodeException(Napi::Env& env, const std::exception& e)
{
    if (dynamic_cast<const Napi::Error*>(&e))
        throw; // Just allow exception propagation to continue
    // TODO consider throwing more specific errors in some cases.
    // TODO consider using ThrowAsJavaScriptException instead here.
    throw Napi::Error::New(env, e.what());
}

// Equivalent to auto(x) in c++23.
#define REALM_DECAY_COPY(x) std::decay_t<decltype(x)>(x)

#define FWD(x) std::forward<decltype(x)>(x)

} // namespace
} // namespace realm::js::node