import asyncio
from papr import Papr

async def test_retrieve_history():
    # Initialize client with API key
    client = Papr(
        x_api_key='sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I'
    )
    
    chat_id = '444e1d63-1759-4d1c-a88d-903e01be186b'
    
    print("Testing Python SDK (what Paprwork uses):")
    print("=" * 80)
    
    # Test with different limits
    for limit in [10, 50, 100]:
        print(f"\nLimit={limit}:")
        response = await client.messages.sessions.retrieve_history(
            session_id=chat_id,
            limit=limit
        )
        
        # Count roles
        role_count = {}
        for msg in response.messages:
            role = msg.role
            role_count[role] = role_count.get(role, 0) + 1
        
        print(f"  Retrieved: {len(response.messages)}/{response.total_count} messages")
        print(f"  Roles: {role_count}")
        
        # Show all messages
        print(f"  Messages:")
        for i, msg in enumerate(response.messages):
            ts = getattr(msg, 'timestamp', None) or getattr(msg, 'created_at', None)
            print(f"    [{i}] {msg.role:<10} {ts}")

if __name__ == "__main__":
    asyncio.run(test_retrieve_history())
